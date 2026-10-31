import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { linkTargets, patchDshConfig, readRuntimeManifest, writeRuntimeManifest } from "../../src/cli/runtime-link.ts";
import { BROWSERS, browserIds, executableCandidates, installedBrowsers, windowsRegistryKey } from "../../src/cli/browsers.ts";
import { HOST_NAME, readRegistration, resolveExtensionIds } from "../../src/cli/native-host.ts";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("runtime manifests use schema v2 desired state and keep contract metadata", () => {
  const dir = tempDir("runtime-manifest-v2-");
  try {
    const root = path.join(dir, "package"); fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium",version: "2.0.0",toolContractVersion: 2 }));
    const written = writeRuntimeManifest(root, dir);
    const read = readRuntimeManifest(dir);
    assert.equal(written.schemaVersion, 2);
    assert.equal(read.desired.root, path.resolve(root));
    assert.equal(read.desired.contractVersion, 2);
    assert.equal(read.generation, 0);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
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

test("Windows Firefox and LibreWolf read the same native host manifest", () => {
  if (process.platform !== "win32") return;
  const dir = tempDir("runtime-link-firefox-registration-");
  try {
    const manifestPath = path.join(dir, "com.opencode.browser.plugin.firefox.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, path: "launcher.cmd", allowed_extensions: ["opencode-browser-plugin@quindart.com"] }));
    const firefox = readRegistration("firefox", dir);
    const librewolf = readRegistration("librewolf", dir);
    assert.equal(librewolf.manifestPath, manifestPath);
    assert.equal(librewolf.hostPath, "launcher.cmd");
    assert.deepEqual(librewolf.extensionIds, firefox.extensionIds);
  } finally { removeDir(dir); }
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
