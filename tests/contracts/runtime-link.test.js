import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { buildStatus, sourceFingerprint } from "../../src/cli/source-fingerprint.js";
import { LAUNCHER_FINGERPRINT_SOURCE, launcherSource, linkTargets, patchDshConfig, readRuntimeManifest, writeLaunchers, writeRuntimeManifest } from "../../src/cli/runtime-link.js";
import { BROWSERS, browserIds, executableCandidates, installedBrowsers, windowsRegistryKey } from "../../src/cli/browsers.js";
import { HOST_NAME, readRegistration, resolveExtensionIds } from "../../src/cli/native-host.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("production updates preserve memory, credentials, and usage paths; isolation is explicit and honors overrides", () => {
  const dir = fs.realpathSync(tempDir("runtime-state-continuity-"));
  try {
    const root = path.join(dir, "package"); fs.mkdirSync(path.join(root, "native-host/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(root, "native-host/dist/runtime.js"), 'console.log(JSON.stringify({memory:process.env.OPENCODE_BROWSER_MEMORY_DIR??null,provider:process.env.AGENT_BROWSER_PROVIDER_DIR??null}))');
    fs.writeFileSync(path.join(dir, "host.mjs"), launcherSource("host"));
    const variables = { ...process.env }; delete variables.OPENCODE_BROWSER_MEMORY_DIR; delete variables.AGENT_BROWSER_PROVIDER_DIR;
    const run = (activation, env = variables) => {
      fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ root, ...activation }));
      return JSON.parse(execFileSync(process.execPath, [path.join(dir, "host.mjs")], { env, encoding: "utf8" }));
    };
    for (const activation of [{ version: "1.8.1" }, { version: "1.8.2", channel: "production" }, { version: "1.8.3", channel: "development" }]) {
      assert.deepEqual(run(activation), { memory: null, provider: null }, "release channels must keep the established platform defaults");
    }
    const custom = { ...variables, OPENCODE_BROWSER_MEMORY_DIR: path.join(dir, "my-memory"), AGENT_BROWSER_PROVIDER_DIR: path.join(dir, "my-credentials") };
    assert.deepEqual(run({ channel: "production", stateIsolation: true }, custom), { memory: custom.OPENCODE_BROWSER_MEMORY_DIR, provider: custom.AGENT_BROWSER_PROVIDER_DIR });
    for (const folder of ["memory", "providers"]) {
      const target = path.join(dir, "state/development", folder); fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "identity"), folder);
    }
    const isolated = run({ channel: "development", stateIsolation: true });
    // Windows short paths and macOS /var aliases may have different spelling.
    // Verify that each launcher path addresses the intended storage directory.
    assert.equal(fs.readFileSync(path.join(isolated.memory, "identity"), "utf8"), "memory");
    assert.equal(fs.readFileSync(path.join(isolated.provider, "identity"), "utf8"), "providers");
  } finally { removeDir(dir); }
});

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
    assert.match(host, /native-host", "dist", "runtime\.js"/, "the native host launches the compiled runtime");
    assert.match(mcp, /DIST_ENTRY = "dist\/adapters\/mcp\/server\.js"/);
    assert.match(plugin, /export default mod\.default/, "OpenCode reads the plugin exports from the active root");
    assert.match(plugin, /opencodeBrowserPlugin/);
  } finally {
    removeDir(dir);
  }
});

// The launcher has to work on a branch that predates source-fingerprint.js, so
// it carries its own copy. This is what stops the two from drifting apart.
test("the launcher's inline fingerprint matches the canonical implementation", async () => {
  const root = fakeTree();
  try {
    // Import the generated source in the same ESM scope as the real launcher.
    const modulePath = path.join(root, "fingerprint.mjs");
    fs.writeFileSync(modulePath, `import fs from "node:fs";\nimport path from "node:path";\nimport { createHash } from "node:crypto";\n${LAUNCHER_FINGERPRINT_SOURCE}\nexport default fingerprint;\n`);
    const { default: inline } = await import(pathToFileURL(modulePath).href);
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

// One browser inventory: the profile directory, the registration key and the
// executable location are the same facts whoever asks for them.
test("the browser inventory describes every supported browser on every OS", () => {
  for (const browser of browserIds()) {
    const entry = BROWSERS[browser];
    assert.equal(typeof entry.registryRoot, "string", `${browser} needs a registry root`);
    assert.equal(typeof entry.name, "string");
    for (const platform of ["win32", "darwin", "linux"]) {
      assert.ok(Array.isArray(entry.userDataDir[platform]), `${browser} needs a ${platform} user-data dir`);
    }
    assert.ok(Array.isArray(entry.windowsExecutables) && entry.windowsExecutables.length > 0);
    assert.ok(Array.isArray(entry.macApps) && entry.macApps.length > 0);
    assert.ok(Array.isArray(entry.linuxPaths) && entry.linuxPaths.length > 0);
    assert.ok(windowsRegistryKey(browser, "com.example.host").endsWith(`\com.example.host`));
  }
});

test("an uninstalled browser is not reported as installed", () => {
  // The detector must be executable-based, not merely "a folder exists":
  // leftover profile directories are common and register browsers that are gone.
  const installed = new Set(installedBrowsers());
  for (const browser of browserIds()) {
    if (installed.has(browser)) continue;
    const candidates = executableCandidates(browser);
    assert.ok(candidates.length >= 0);
    assert.equal(candidates.some((candidate) => fs.existsSync(candidate)), false, `${browser} has a real executable but was not reported`);
  }
});

test("registration requires a real manifest, not just a file on disk", () => {
  const dir = tempDir("runtime-link-registration-");
  try {
    assert.equal(readRegistration("brave", dir).registered, false, "no manifest means no registration");
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({ name: "someone.else", path: "x" }), "utf8");
    assert.equal(readRegistration("brave", dir).registered, false, "a foreign manifest is not our registration");
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({
      name: HOST_NAME,
      path: "C:/launcher/opencode-browser-host.cmd",
      allowed_origins: ["chrome-extension://aaa/", "chrome-extension://bbb/"],
    }), "utf8");
    const registration = readRegistration("brave", dir);
    assert.deepEqual(registration.extensionIds, ["aaa", "bbb"], "origins are reduced to bare ids");
  } finally {
    removeDir(dir);
  }
});

// Each id source can be incomplete on its own, so they are merged rather than
// letting whichever answered first lock out an extension that is also allowed.
test("extension id sources are merged, not narrowed", () => {
  const dir = tempDir("runtime-link-ids-");
  try {
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.edge.json"), JSON.stringify({
      name: HOST_NAME,
      path: "x",
      allowed_origins: ["chrome-extension://from-manifest/"],
    }), "utf8");
    const resolved = resolveExtensionIds({ browser: "edge", noDetection: true, targetDir: dir }import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildStatus, sourceFingerprint } from "../../src/cli/source-fi);
    assert.equal(resolved.extensionIds.includes("from-manifest"), true);
    const withArgument = resolveExtensionIds({ browser: "edge", extensionIds: ["explicit"], targetDir: dir });
    assert.deepEqual(withArgument.extensionIds, ["explicit"], "an explicit list wins outright");
  } finally {
    removeDir(dir);
  }
});

// Dropping a registration for a browser whose executable we cannot find would
// break a working setup, so previously registered browsers are always kept.
test("link targets installed browsers plus already-registered ones", () => {
  const dir = tempDir("runtime-link-targets-");
  try {
    const targets = linkTargets(dir);
    for (const browser of installedBrowsers()) assert.equal(targets.includes(browser), true, `${browser} is installed but not targeted`);
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({
      name: HOST_NAME,
      path: "C:/launcher/opencode-browser-host.cmd",
      allowed_origins: ["chrome-extension://aaa/"],
    }), "utf8");
    const updatedTargets = linkTargets(dir);
    assert.equal(new Set(updatedTargets).size, updatedTargets.length, "targets must be unique");
  } finally {
    removeDir(dir);
  }
});

// Chromium resolves a native messaging host through several registry roots and
// stops at the first valid manifest. Brave can look in the shared Chrome root
// rather than its own, so omitting `chrome` from the targets because its
// executable is absent leaves the host invisible and every connectNative fails
// with "Specified native messaging host not found".
test("link targets always include the shared Chromium root", () => {
  const dir = tempDir("runtime-link-shared-root-");
  try {
    // A browser is only a target here when its executable is absent, which is
    // exactly the condition that used to drop `chrome`.
    const installed = new Set(installedBrowsers());
    const absent = browserIds().filter((browser) => !installed.has(browser));
    const targets = linkTargets(dir);
    for (const browser of ["chrome", ...absent.filter((id) => id !== "chrome")]) {
      assert.equal(targets.includes("chrome"), true, `${browser} must not remove the shared Chrome root`);
    }
    assert.equal(targets.includes("chrome"), true, "chrome is always targeted");
  } finally {
    removeDir(dir);
  }
});
ngerprint.js";
import { LAUNCHER_FINGERPRINT_SOURCE, launcherSource, linkTargets, patchDshConfig, readRuntimeManifest, writeLaunchers, writeRuntimeManifest } from "../../src/cli/runtime-link.js";
import { BROWSERS, browserIds, executableCandidates, installedBrowsers, windowsRegistryKey } from "../../src/cli/browsers.js";
import { HOST_NAME, readRegistration, resolveExtensionIds } from "../../src/cli/native-host.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("production updates preserve memory, credentials, and usage paths; isolation is explicit and honors overrides", () => {
  const dir = fs.realpathSync(tempDir("runtime-state-continuity-"));
  try {
    const root = path.join(dir, "package"); fs.mkdirSync(path.join(root, "native-host/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(root, "native-host/dist/runtime.js"), 'console.log(JSON.stringify({memory:process.env.OPENCODE_BROWSER_MEMORY_DIR??null,provider:process.env.AGENT_BROWSER_PROVIDER_DIR??null}))');
    fs.writeFileSync(path.join(dir, "host.mjs"), launcherSource("host"));
    const variables = { ...process.env }; delete variables.OPENCODE_BROWSER_MEMORY_DIR; delete variables.AGENT_BROWSER_PROVIDER_DIR;
    const run = (activation, env = variables) => {
      fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ root, ...activation }));
      return JSON.parse(execFileSync(process.execPath, [path.join(dir, "host.mjs")], { env, encoding: "utf8" }));
    };
    for (const activation of [{ version: "1.8.1" }, { version: "1.8.2", channel: "production" }, { version: "1.8.3", channel: "development" }]) {
      assert.deepEqual(run(activation), { memory: null, provider: null }, "release channels must keep the established platform defaults");
    }
    const custom = { ...variables, OPENCODE_BROWSER_MEMORY_DIR: path.join(dir, "my-memory"), AGENT_BROWSER_PROVIDER_DIR: path.join(dir, "my-credentials") };
    assert.deepEqual(run({ channel: "production", stateIsolation: true }, custom), { memory: custom.OPENCODE_BROWSER_MEMORY_DIR, provider: custom.AGENT_BROWSER_PROVIDER_DIR });
    for (const folder of ["memory", "providers"]) {
      const target = path.join(dir, "state/development", folder); fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "identity"), folder);
    }
    const isolated = run({ channel: "development", stateIsolation: true });
    // Windows short paths and macOS /var aliases may have different spelling.
    // Verify that each launcher path addresses the intended storage directory.
    assert.equal(fs.readFileSync(path.join(isolated.memory, "identity"), "utf8"), "memory");
    assert.equal(fs.readFileSync(path.join(isolated.provider, "identity"), "utf8"), "providers");
  } finally { removeDir(dir); }
});

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
    assert.match(host, /native-host", "dist", "runtime\.js"/, "the native host launches the compiled runtime");
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

// One browser inventory: the profile directory, the registration key and the
// executable location are the same facts whoever asks for them.
test("the browser inventory describes every supported browser on every OS", () => {
  for (const browser of browserIds()) {
    const entry = BROWSERS[browser];
    assert.equal(typeof entry.registryRoot, "string", `${browser} needs a registry root`);
    assert.equal(typeof entry.name, "string");
    for (const platform of ["win32", "darwin", "linux"]) {
      assert.ok(Array.isArray(entry.userDataDir[platform]), `${browser} needs a ${platform} user-data dir`);
    }
    assert.ok(Array.isArray(entry.windowsExecutables) && entry.windowsExecutables.length > 0);
    assert.ok(Array.isArray(entry.macApps) && entry.macApps.length > 0);
    assert.ok(Array.isArray(entry.linuxPaths) && entry.linuxPaths.length > 0);
    assert.ok(windowsRegistryKey(browser, "com.example.host").endsWith(`\com.example.host`));
  }
});

test("an uninstalled browser is not reported as installed", () => {
  // The detector must be executable-based, not merely "a folder exists":
  // leftover profile directories are common and register browsers that are gone.
  const installed = new Set(installedBrowsers());
  for (const browser of browserIds()) {
    if (installed.has(browser)) continue;
    const candidates = executableCandidates(browser);
    assert.ok(candidates.length >= 0);
    assert.equal(candidates.some((candidate) => fs.existsSync(candidate)), false, `${browser} has a real executable but was not reported`);
  }
});

test("registration requires a real manifest, not just a file on disk", () => {
  const dir = tempDir("runtime-link-registration-");
  try {
    assert.equal(readRegistration("brave", dir).registered, false, "no manifest means no registration");
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({ name: "someone.else", path: "x" }), "utf8");
    assert.equal(readRegistration("brave", dir).registered, false, "a foreign manifest is not our registration");
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({
      name: HOST_NAME,
      path: "C:/launcher/opencode-browser-host.cmd",
      allowed_origins: ["chrome-extension://aaa/", "chrome-extension://bbb/"],
    }), "utf8");
    const registration = readRegistration("brave", dir);
    assert.deepEqual(registration.extensionIds, ["aaa", "bbb"], "origins are reduced to bare ids");
  } finally {
    removeDir(dir);
  }
});

// Each id source can be incomplete on its own, so they are merged rather than
// letting whichever answered first lock out an extension that is also allowed.
test("extension id sources are merged, not narrowed", () => {
  const dir = tempDir("runtime-link-ids-");
  try {
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.edge.json"), JSON.stringify({
      name: HOST_NAME,
      path: "x",
      allowed_origins: ["chrome-extension://from-manifest/"],
    }), "utf8");
    const resolved = resolveExtensionIds({ browser: "edge", noDetection: true, targetDir: dir });
    assert.equal(resolved.extensionIds.includes("from-manifest"), true);
    const withArgument = resolveExtensionIds({ browser: "edge", extensionIds: ["explicit"], targetDir: dir });
    assert.deepEqual(withArgument.extensionIds, ["explicit"], "an explicit list wins outright");
  } finally {
    removeDir(dir);
  }
});

// Dropping a registration for a browser whose executable we cannot find would
// break a working setup, so previously registered browsers are always kept.
test("link targets installed browsers plus already-registered ones", () => {
  const dir = tempDir("runtime-link-targets-");
  try {
    const targets = linkTargets(dir);
    for (const browser of installedBrowsers()) assert.equal(targets.includes(browser), true, `${browser} is installed but not targeted`);
    fs.writeFileSync(path.join(dir, "com.opencode.browser.plugin.brave.json"), JSON.stringify({
      name: HOST_NAME,
      path: "C:/launcher/opencode-browser-host.cmd",
      allowed_origins: ["chrome-extension://aaa/"],
    }), "utf8");
    const updatedTargets = linkTargets(dir);
    assert.equal(new Set(updatedTargets).size, updatedTargets.length, "targets must be unique");
  } finally {
    removeDir(dir);
  }
});

// Chromium resolves a native messaging host through several registry roots and
// stops at the first valid manifest. Brave can look in the shared Chrome root
// rather than its own, so omitting `chrome` from the targets because its
// executable is absent leaves the host invisible and every connectNative fails
// with "Specified native messaging host not found".
test("link targets always include the shared Chromium root", () => {
  const dir = tempDir("runtime-link-shared-root-");
  try {
    // A browser is only a target here when its executable is absent, which is
    // exactly the condition that used to drop `chrome`.
    const installed = new Set(installedBrowsers());
    const absent = browserIds().filter((browser) => !installed.has(browser));
    const targets = linkTargets(dir);
    for (const browser of ["chrome", ...absent.filter((id) => id !== "chrome")]) {
      assert.equal(targets.includes("chrome"), true, `${browser} must not remove the shared Chrome root`);
    }
    assert.equal(targets.includes("chrome"), true, "chrome is always targeted");
  } finally {
    removeDir(dir);
  }
});
