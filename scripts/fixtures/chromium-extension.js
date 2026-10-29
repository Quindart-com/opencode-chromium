import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash,generateKeyPairSync,randomBytes } from "node:crypto";
import { chromium } from "playwright";

/** Unique host name and disposable profile: never replaces an installed host. */
export async function chromiumExtensionFixture({ headless = true } = {}) {
  const root = process.cwd(), fixture = fs.mkdtempSync(path.join(os.tmpdir(), "browser-reliability-"));
  const source = path.join(fixture, "extension"), registry = path.join(fixture, "registry"), profile = path.join(fixture, "profile");
  fs.cpSync(path.join(root, "extension"), source, { recursive: true }); fs.mkdirSync(registry);
  const host = "com.opencode.browser.test" + randomBytes(5).toString("hex");
  const background = path.join(source, "background.js");
  fs.writeFileSync(background, fs.readFileSync(background, "utf8").replaceAll("com.opencode.browser.plugin", host));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
  const extensionId = [...createHash("sha256").update(key).digest().subarray(0, 16)].flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join("");
  const manifestPath = path.join(source, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: key.toString("base64") }));
  const env = { ...process.env, OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: registry, OPENCODE_BROWSER_RUNTIME_DIR: path.join(fixture, "runtime"),
    OPENCODE_BROWSER_MEMORY_DIR: path.join(fixture, "memory"), AGENT_BROWSER_PROVIDER_DIR: path.join(fixture, "providers"), OPENCODE_BROWSER_SEMANTIC_DIR: path.join(fixture, "models") };
  const launcher = path.join(fixture, process.platform === "win32" ? "native.cmd" : "native.sh");
  const variables = ["OPENCODE_BROWSER_PROFILE_REGISTRY_DIR", "OPENCODE_BROWSER_RUNTIME_DIR", "OPENCODE_BROWSER_MEMORY_DIR", "AGENT_BROWSER_PROVIDER_DIR", "OPENCODE_BROWSER_SEMANTIC_DIR"];
  fs.writeFileSync(launcher, process.platform === "win32" ? '@echo off\r\n' + variables.map(k => 'set "' + k + '=' + env[k] + '"').join('\r\n') + '\r\n"' + process.execPath + '" "' + path.join(root, "native-host/dist/runtime.js") + '"\r\n' : '#!/bin/sh\n' + variables.map(k => 'export ' + k + '=' + JSON.stringify(env[k])).join('\n') + '\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(root, "native-host/dist/runtime.js")) + '\n', { mode: 0o700 });
  const nativeManifest = path.join(fixture, "native.json");
  fs.writeFileSync(nativeManifest, JSON.stringify({ name: host, description: "Disposable reliability verification", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }));
  let nativeKey, context;
  const cleanup = async () => {
    await context?.close().catch(() => {});
    if (nativeKey) { try { execFileSync("reg", ["delete", nativeKey, "/f"], { stdio: "ignore", windowsHide: true }); } catch {} }
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.error("Owned fixture cleanup pending:", fixture); }
  };
  try {
    if (process.platform === "win32") {
      const candidateKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + host;
      let exists = false; try { execFileSync("reg", ["query", candidateKey], { stdio: "ignore" }); exists = true; } catch {}
      assert.equal(exists, false, "never overwrite an existing host");
      execFileSync("reg", ["add", candidateKey, "/ve", "/t", "REG_SZ", "/d", nativeManifest, "/f"], { stdio: "ignore", windowsHide: true });
      nativeKey = candidateKey;
    } else {
      env.HOME = fixture; env.XDG_CONFIG_HOME = path.join(fixture, ".config");
      // Chromium resolves user hosts under --user-data-dir, including custom profiles.
      const dir = path.join(profile, "NativeMessagingHosts");
      fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(nativeManifest, path.join(dir, host + ".json"));
    }
    context = await chromium.launchPersistentContext(profile, { headless, channel: "chromium", env, viewport: { width: 1100, height: 900 },
      args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`, "--site-per-process"] });
    let registration;
    for (let i = 0; i < 100; i++) {
      const file = fs.readdirSync(registry).find(name => name.endsWith(".json"));
      if (file) { registration = JSON.parse(fs.readFileSync(path.join(registry, file), "utf8")); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!registration) throw new Error("Disposable extension did not connect to its native host");
    process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = registry;
    return { context, profileId: registration.profileId, fixture, extensionId, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
