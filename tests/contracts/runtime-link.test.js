import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildStatus, sourceFingerprint } from "../../src/cli/source-fingerprint.js";
import { LAUNCHER_FINGERPRINT_SOURCE, launcherSource, patchDshConfig, readRuntimeManifest, writeLaunchers, writeRuntimeManifest } from "../../src/cli/runtime-link.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  } catch {
    // Windows can hold handles briefly; the OS cleans temp dirs up.
  }
}

function fakeTree() {
  const root = tempDir("runtime-link-tree-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium", version: "1.7.2" }), "utf8");
  fs.mkdirSync(path.join(root, "src", "cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "cli", "index.js"), "export const value = 1;\n", "utf8");
  fs.mkdirSync(path.join(root, "native-host", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "native-host", "src", "host.js"), "// host\n", "utf8");
  return root;
}

test("the source fingerprint tracks every input to the bundle", () => {
  const root = fakeTree();
  try {
    const first = sourceFingerprint(root);
    assert.equal(sourceFingerprint(root), first, "the same tree must hash identically");

    fs.writeFileSync(path.join(root, "src", "cli", "index.js"), "export const value = 2;\n", "utf8");
    assert.notEqual(sourceFingerprint(root), first, "a source edit must invalidate the build");

    const afterSourceEdit = sourceFingerprint(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium", version: "1.7.3" }), "utf8");
    assert.notEqual(sourceFingerprint(root), afterSourceEdit, "a version bump alone must invalidate the build");

    const afterVersion = sourceFingerprint(root);
    fs.writeFileSync(path.join(root, "native-host", "src", "host.js"), "// host changed\n", "utf8");
    assert.notEqual(sourceFingerprint(root), afterVersion, "the native host feeds the bundle too");
  } finally {
    removeDir(root);
  }
});

test("build status separates a missing bundle from a stale one", () => {
  const root = fakeTree();
  try {
    assert.deepEqual(buildStatus(root).built, false);
    assert.equal(buildStatus(root).stale, true);

    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    const write = (sourceSha256) => fs.writeFileSync(
      path.join(root, "dist", "build-manifest.json"),
      JSON.stringify({ version: "1.7.2", generatedAt: "2026-01-01T00:00:00.000Z", sourceSha256 }),
      "utf8",
    );
    write(sourceFingerprint(root));
    assert.equal(buildStatus(root).stale, false);

    write("a-different-tree");
    assert.equal(buildStatus(root).stale, true, "a bundle built from other sources is stale");

    // A manifest written before this check existed cannot be trusted.
    write(undefined);
    assert.equal(buildStatus(root).stale, true);
  } finally {
    removeDir(root);
  }
});

test("launchers resolve the runtime root instead of pinning a checkout", () => {
  const dir = tempDir("runtime-link-dir-");
  try {
    writeRuntimeManifest("C:/some/checkout", dir);
    assert.equal(readRuntimeManifest(dir).root, path.resolve("C:/some/checkout"));

    const host = launcherSource("host");
    const mcp = launcherSource("mcp");
    const plugin = launcherSource("plugin");

    for (const source of [host, mcp, plugin]) {
      assert.match(source, /runtime\.json/, "every launcher resolves the manifest at launch time");
      assert.equal(/C:\/some\/checkout|Opencode-Plugins/.test(source), false, "no launcher may pin an absolute checkout");
    }
    assert.match(host, /native-host", "src", "host\.js"/, "the host runs from source, so a branch switch needs no build");
    assert.match(mcp, /DIST_ENTRY = "dist\/adapters\/mcp\/server\.js"/);
    assert.match(plugin, /export default mod\.default/, "OpenCode reads the plugin exports from the active root");
    assert.match(plugin, /opencodeBrowserPlugin/);
  } finally {
    removeDir(dir);
  }
});

// The launcher has to work on a branch that predates source-fingerprint.js, so
// it carries its own copy. This is what stops the two from drifting apart.
test("the launcher's inline fingerprint matches the canonical implementation", () => {
  const root = fakeTree();
  try {
    // Evaluated the way the generated launcher runs it: ESM top-level scope,
    // where the node:crypto import is already bound.
    const inline = new Function("fs", "path", "createHash", `${LAUNCHER_FINGERPRINT_SOURCE}\nreturn fingerprint;`)(fs, path, createHash);
    assert.equal(inline(root), sourceFingerprint(root));

    fs.writeFileSync(path.join(root, "src", "cli", "index.js"), "export const value = 3;\n", "utf8");
    assert.equal(inline(root), sourceFingerprint(root), "both must react to an edit the same way");
  } finally {
    removeDir(root);
  }
});

test("the launcher never uses require, which an ESM module does not have", () => {
  for (const kind of ["mcp", "plugin"]) {
    const source = launcherSource(kind);
    assert.doesNotMatch(source, /\brequire\(/, "a generated launcher is an ES module");
    assert.match(source, /import \{ createHash \} from "node:crypto"/);
  }
});

test("the launcher never imports from the checkout before it can start", () => {
  for (const kind of ["mcp", "plugin"]) {
    const source = launcherSource(kind);
    assert.doesNotMatch(source, /await import\(pathToFileURL\(path\.join\(root, "src"/, "a branch that predates this module would break the launcher");
    assert.match(source, /function fingerprint\(root\)/, "the check must be self-contained");
    assert.match(source, /no bundle at/, "a missing bundle must fail with an actionable message");
  }
});

test("an older bundle without a source hash is judged by time, not rebuilt forever", () => {
  const source = launcherSource("mcp");
  assert.match(source, /typeof built\.sourceSha256 === "string"/);
  assert.match(source, /newestSourceMtime\(root\)/, "legacy manifests fall back to a timestamp comparison");
});

test("the launcher rebuilds a stale bundle but still starts the last good one", () => {
  const source = launcherSource("mcp");
  assert.match(source, /function fingerprint\(root\)/);
  assert.match(source, /spawnSync/);
  assert.match(source, /build failed; starting the last successful bundle/);
  // Command-line flags must reach the server, not the launcher.
  assert.match(source, /process\.argv = \[process\.argv\[0\], entry, \.\.\.process\.argv\.slice\(2\)\]/);
});

test("writeLaunchers keeps the browser registration filename stable", () => {
  const dir = tempDir("runtime-link-launchers-");
  const root = fakeTree();
  try {
    const written = writeLaunchers(root, dir);
    assert.equal(path.basename(written.wrapper), process.platform === "win32" ? "opencode-browser-host.cmd" : "opencode-browser-host");
    for (const file of [written.host, written.mcp, written.plugin, written.wrapper]) {
      assert.equal(fs.existsSync(file), true, `${file} must exist`);
    }
    if (process.platform !== "win32") {
      assert.notEqual(fs.statSync(written.host).mode & 0o111, 0, "launchers must be executable on unix");
    }
  } finally {
    removeDir(dir);
    removeDir(root);
  }
});

test("the DSH profile patch rewrites one argument and preserves every comment", () => {
  const dir = tempDir("runtime-link-dsh-");
  try {
    const file = path.join(dir, "cordis.patch.yml");
    const original = [
      "# Verified handshake: {\"serverInfo\":{\"name\":\"opencode-browser-plugin\"}}",
      "    - id: mcp-browser",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: browser",
      "        command: 'C:\\Program Files\\nodejs\\node.exe'",
      "        args:",
      "          - 'C:\\old\\dist\\adapters\\mcp\\server.js'",
      "    - id: mcp-other",
      "      config:",
      "        args:",
      "          - 'C:\\other\\server.js'",
      "",
    ].join("\n");
    fs.writeFileSync(file, original, "utf8");

    const result = patchDshConfig(file, "C:\\launcher\\mcp.mjs");
    assert.equal(result.changed, true);
    const patched = fs.readFileSync(file, "utf8");
    assert.match(patched, /# Verified handshake/, "comments must survive");
    assert.match(patched, /- 'C:\\launcher\\mcp\.mjs'/);
    assert.equal(patched.includes("C:\\old\\dist"), false);
    assert.equal(patched.includes("- 'C:\\other\\server.js'"), true, "other servers must be untouched");
    assert.match(result.backup, /\.bak-/);

    assert.equal(patchDshConfig(file, "C:\\launcher\\mcp.mjs").changed, false, "patching is idempotent");
  } finally {
    removeDir(dir);
  }
});

test("an absent DSH profile is reported, not created", () => {
  const dir = tempDir("runtime-link-dsh-missing-");
  try {
    const result = patchDshConfig(path.join(dir, "nope.yml"), "C:\\launcher\\mcp.mjs");
    assert.equal(result.changed, false);
    assert.equal(result.reason, "not installed");
  } finally {
    removeDir(dir);
  }
});

// The CLI is versioned with the branch, so a branch that predates the status
// command must still be able to answer "which version is live?".
test("the status launcher reports something on a branch without the status command", () => {
  const dir = tempDir("runtime-link-status-");
  const root = fakeTree();
  try {
    const written = writeLaunchers(root, dir);
    assert.equal(fs.existsSync(written.status), true);
    const source = fs.readFileSync(written.status, "utf8");
    assert.match(source, /runtime-link\.js/, "it delegates to the active root when that root can answer");
    assert.match(source, /this branch predates the status command/, "and degrades to a minimal report when it cannot");
    assert.doesNotMatch(source, /\brequire\(/);
  } finally {
    removeDir(dir);
    removeDir(root);
  }
});
