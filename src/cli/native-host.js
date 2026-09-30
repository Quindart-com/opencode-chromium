#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { BROWSERS, browserIds, browserUserDataRoot, installedBrowsers, nativeMessagingDir, windowsRegistryKey } from "./browsers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.opencode.browser.plugin";
export { HOST_NAME };
function usage() {
  console.error("Usage: node scripts/install-native-host.js [--auto] [--extension-id <id> ...] [--browsers chrome,edge,brave,chromium|all] [--host-path <executable>]");
  console.error("");
  console.error("The extension ID is visible on chrome://extensions after loading extension/ as unpacked.");
  console.error("When no ID is given, scripts/extension-id.json is used (repeat --extension-id to allow more than one).");
  console.error("--host-path registers an existing launcher instead of a wrapper pinned to this checkout.");
}

function parseArgs(argv) {
  const args = { browsers: null, extensionIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--extension-id") {
      args.extensionIds.push(argv[++i]);
      continue;
    }
    if (arg === "--auto") {
      args.auto = true;
      // Only browsers that are actually installed: registering the others
      // leaves stray manifests and registry keys behind.
      args.browsers = installedBrowsers();
      if (args.browsers.length === 0) args.browsers = ["chrome"];
      continue;
    }
    // Register an already-installed launcher instead of writing a wrapper that
    // pins this checkout. `opencode-chromium link` uses this so the browser
    // registration survives every future branch switch and version change.
    if (arg === "--host-path") {
      args.hostPath = path.resolve(argv[++i]);
      continue;
    }
    // Extension ids are only needed when they cannot be detected; a caller that
    // already resolved them may pass an empty list on purpose.
    if (arg === "--no-extension-detection") {
      args.noDetection = true;
      continue;
    }
    if (arg === "--browsers") {
      const browsers = argv[++i].split(",").map((item) => item.trim()).filter(Boolean);
      args.browsers = browsers.includes("all") ? browserIds() : browsers;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.extensionIds.length === 0) {
    const env = process.env.AGENT_BROWSER_EXTENSION_ID ?? process.env.OPENCODE_BROWSER_EXTENSION_ID;
    if (env) args.extensionIds = env.split(",").map((id) => id.trim()).filter(Boolean);
  }
  if (args.extensionIds.length === 0 && !args.auto) {
    const config = readJsonIfPresent(path.join(repoRoot(), "scripts", "extension-id.json"));
    const configured = Array.isArray(config?.extensionIds) ? config.extensionIds : typeof config?.extensionId === "string" ? [config.extensionId] : [];
    args.extensionIds = configured.filter((id) => typeof id === "string" && id.length > 0);
  }
  if (args.extensionIds.length === 0 && !args.auto) throw new Error("Missing --extension-id, OPENCODE_BROWSER_EXTENSION_ID, or --auto");
  args.browsers ??= ["chrome"];
  for (const browser of args.browsers) {
    if (!BROWSERS[browser]) throw new Error(`Unsupported browser: ${browser}`);
  }
  return args;
}

function repoRoot() {
  // This module lives in src/cli, so the package root is two levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// One per-user location holds the launchers, the manifests and the pointer, so
// the browser registration and every client config can be written once and
// never change again.
const RUNTIME_DIR_ENV = "OPENCODE_BROWSER_RUNTIME_DIR";

export function runtimeDir() {
  const configured = process.env[RUNTIME_DIR_ENV];
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser");
  }
  return path.join(os.homedir(), ".config", "opencode", "browser");
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function detectExtensionIds(browser) {
  const root = browserUserDataRoot(browser);
  if (!root || !fs.existsSync(root)) return [];

  const ids = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const preferencesFile of ["Secure Preferences", "Preferences"]) {
      const preferences = readJsonIfPresent(path.join(root, entry.name, preferencesFile));
      const settings = preferences?.extensions?.settings;
      if (!settings || typeof settings !== "object") continue;

      for (const [id, extension] of Object.entries(settings)) {
        const name = extension?.manifest?.name ?? "";
        const extensionPath = extension?.path ?? "";
        if (/opencode-browser-plugin|opencode-chromium/i.test(name) || /opencode-browser-plugin|opencode-chromium/i.test(extensionPath) || /Opencode-Plugins/i.test(extensionPath)) {
          ids.add(id);
        }
      }
    }
  }

  return [...ids];
}

function writeWrapper(targetDir, launcherPath) {
  const windows = process.platform === "win32";
  const wrapperPath = path.join(targetDir, windows ? "opencode-browser-host.cmd" : "opencode-browser-host");
  fs.writeFileSync(wrapperPath, windows
    ? `@echo off\r\n"${process.execPath}" "${launcherPath}"\r\n`
    : `#!/usr/bin/env sh\nexec "${process.execPath}" "${launcherPath}"\n`, { encoding: "utf8", mode: windows ? undefined : 0o755 });
  return wrapperPath;
}

function manifestPathForBrowser(browser, targetDir) {
  if (process.platform === "win32") return path.join(targetDir, `${HOST_NAME}.${browser}.json`);
  const manifestDir = nativeMessagingDir(browser);
  if (!manifestDir) return path.join(targetDir, `${HOST_NAME}.${browser}.json`);
  fs.mkdirSync(manifestDir, { recursive: true });
  return path.join(manifestDir, `${HOST_NAME}.json`);
}

function writeManifest({ browser, extensionIds, hostPath, targetDir }) {
  const manifestPath = manifestPathForBrowser(browser, targetDir);
  const manifest = {
    name: HOST_NAME,
    description: "OpenCode Chromium browser native messaging host",
    path: hostPath,
    type: "stdio",
    allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

// A manifest's allowed origins, reduced to bare extension ids.
export function originIds(manifest) {
  return (manifest?.allowed_origins ?? [])
    .map((origin) => String(origin).replace(/^chrome-extension:\/\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

// What the browser will actually load for a given browser, so callers can
// report registration instead of guessing from a file's existence. On Windows
// the registry entry is the registration; elsewhere the manifest's presence in
// the browser's own directory is.
export function readRegistration(browser, targetDir = runtimeDir()) {
  const browserDir = nativeMessagingDir(browser);
  const browserManifestPath = browserDir ? path.join(browserDir, `${HOST_NAME}.json`) : null;
  const useBrowserDirectory = process.platform !== "win32" && samePath(targetDir, runtimeDir()) && browserManifestPath && fs.existsSync(browserManifestPath);
  const manifestPath = useBrowserDirectory ? browserManifestPath : path.join(targetDir, `${HOST_NAME}.${browser}.json`);
  const manifest = readJsonIfPresent(manifestPath);
  const valid = Boolean(manifest) && manifest.name === HOST_NAME && typeof manifest.path === "string" && originIds(manifest).length > 0;
  const registered = valid && (process.platform === "win32" ? samePath(registryManifestPath(browser), manifestPath) : Boolean(useBrowserDirectory));
  return {
    browser,
    registered,
    manifestPath,
    hostPath: manifest?.path ?? null,
    extensionIds: originIds(manifest),
  };
}

function registryManifestPath(browser) {
  try {
    const output = execFileSync("reg", ["query", windowsRegistryKey(browser, HOST_NAME), "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.match(/REG_SZ\s+(.+?)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function writeExtensionIdConfig(targetDir, extensionIds) {
  if (extensionIds.length === 0) return null;
  const configPath = path.join(targetDir, "extension-ids.json");
  const uniqueIds = [...new Set(extensionIds)];
  const config = {
    extensionHostName: HOST_NAME,
    extensionIds: uniqueIds,
  };
  if (uniqueIds.length === 1) config.extensionId = uniqueIds[0];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function installWindowsRegistry(browser, manifestPath) {
  const registryKey = windowsRegistryKey(browser, HOST_NAME);
  execFileSync("reg", ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// Which extension ids may talk to the host. Every source is consulted and the
// results merged, because each one can be incomplete: detection reads browser
// profiles, which fails whenever the browser is running and holding its
// preferences, and the recorded config may predate an extension. Narrowing to
// whichever source answered first would silently lock out a working extension.
export function resolveExtensionIds({ browser, extensionIds = [], noDetection = false, targetDir = runtimeDir() } = {}) {
  if (extensionIds.length > 0) return { extensionIds, source: "argument" };
  const ids = new Set();
  const sources = [];
  const existing = readRegistration(browser, targetDir).extensionIds;
  if (existing.length > 0) {
    existing.forEach((id) => ids.add(id));
    sources.push("existing manifest");
  }
  if (!noDetection) {
    const detected = detectExtensionIds(browser);
    if (detected.length > 0) {
      detected.forEach((id) => ids.add(id));
      sources.push("detected");
    }
  }
  const recorded = readJsonIfPresent(path.join(targetDir, "extension-ids.json")) ?? readJsonIfPresent(path.join(repoRoot(), "scripts", "extension-id.json"));
  const configured = [].concat(recorded?.extensionIds ?? [], recorded?.extensionId ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (configured.length > 0) {
    configured.forEach((id) => ids.add(id));
    sources.push("scripts/extension-id.json");
  }
  return { extensionIds: [...ids], source: sources.join(" + ") || "none" };
}

export function installManifest(args) {
  const root = repoRoot();
  // Honour a caller's directory instead of always writing to the live runtime
  // dir: a dry run or an isolated check must not overwrite the registration the
  // browser is currently using.
  const targetDir = args.targetDir ?? runtimeDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const hostPath = args.hostPath ?? writeWrapper(targetDir, path.join(root, "native-host", "dist", "runtime.js"));

  const installed = [];
  const skipped = [];
  const allExtensionIds = [];
  for (const browser of args.browsers) {
    const resolved = resolveExtensionIds({ browser, extensionIds: args.extensionIds, noDetection: args.noDetection, targetDir });
    if (resolved.extensionIds.length === 0) {
      skipped.push({ browser, reason: "no extension id known; load extension/ and pass --extension-id" });
      continue;
    }
    const manifestPath = writeManifest({ browser, extensionIds: resolved.extensionIds, hostPath, targetDir });
    if (process.platform === "win32") installWindowsRegistry(browser, manifestPath);
    installed.push({ browser, manifestPath, extensionIds: resolved.extensionIds, resolvedFrom: resolved.source });
    allExtensionIds.push(...resolved.extensionIds);
  }

  const extensionIdConfigPath = writeExtensionIdConfig(targetDir, allExtensionIds);
  return { hostName: HOST_NAME, hostPath, extensionIdConfigPath, installed, skipped };
}

// A registration path comparison must ignore case and separator style.
function samePath(first, second) {
  if (typeof first !== "string" || typeof second !== "string") return false;
  return first.replaceAll("\\", "/").toLowerCase() === second.replaceAll("\\", "/").toLowerCase();
}

export { parseArgs, detectExtensionIds, installedBrowsers };

if (process.argv[1]?.replaceAll("\\", "/").endsWith("cli/native-host.js")) {
  try {
    const result = installManifest(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    // A skipped browser means the tools will not work there; say so in the exit
    // status rather than burying it in the JSON.
    if (result.skipped.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(1);
  }
}
