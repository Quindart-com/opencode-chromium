#!/usr/bin/env node
import type { FileChange } from "../management/transaction.ts";
import { record } from "../shared/values.ts";
export interface NativeHostOptions {
  browsers: string[]; extensionIds: string[]; auto?: boolean; hostPath?: string; targetDir?: string; noDetection?: boolean;
}
export interface RegistryChange { key: string; before: string | null; after: string }

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { browserIds,BROWSERS,browserUserDataRoot,installedBrowsers,nativeMessagingDir,windowsRegistryKey } from "./browsers.ts";

const HOST_NAME = "com.opencode.browser.plugin";
export const FIREFOX_EXTENSION_ID = "opencode-browser-plugin@quindart.com";
export { HOST_NAME };
function usage() {
  console.error("Usage: node scripts/install-native-host.js [--auto] [--extension-id <id> ...] [--browsers chrome,edge,brave,chromium|all] [--host-path <executable>]");
  console.error("");
  console.error("The extension ID is visible on chrome://extensions after loading extension/ as unpacked.");
  console.error("When no ID is given, scripts/extension-id.json is used (repeat --extension-id to allow more than one).");
  console.error("--host-path registers an existing launcher instead of a wrapper pinned to this checkout.");
}

function parseArgs(argv: string[]) {
  const args: Omit<NativeHostOptions, "browsers"> & { browsers: string[] | null } = { browsers: null, extensionIds: [] };
  const requiredValue = (index: number): string => { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argv[index - 1]}`); return value; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--extension-id") {
      args.extensionIds.push(requiredValue(++i));
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
      args.hostPath = path.resolve(requiredValue(++i));
      continue;
    }
    // Extension ids are only needed when they cannot be detected; a caller that
    // already resolved them may pass an empty list on purpose.
    if (arg === "--no-extension-detection") {
      args.noDetection = true;
      continue;
    }
    if (arg === "--browsers") {
      const browsers = requiredValue(++i).split(",").map((item: string) => item.trim()).filter(Boolean);
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
    args.extensionIds = configured.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  }
  if (args.extensionIds.length === 0 && !args.auto && !args.browsers?.every((browser: string) => BROWSERS[browser]?.engine === "gecko")) throw new Error("Missing --extension-id, OPENCODE_BROWSER_EXTENSION_ID, or --auto");
  args.browsers ??= ["chrome"];
  for (const browser of args.browsers) {
    if (!BROWSERS[browser]) throw new Error(`Unsupported browser: ${browser}`);
  }
  return { ...args, browsers: args.browsers };
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

function readJsonIfPresent(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return record((JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown));
  } catch {
    return null;
  }
}

function detectExtensionIds(browser: string): string[] {
  const root = browserUserDataRoot(browser);
  if (!root || !fs.existsSync(root)) return [];

  const ids = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const preferencesFile of ["Secure Preferences", "Preferences"]) {
      const preferences = readJsonIfPresent(path.join(root, entry.name, preferencesFile));
      const settings = record(record(preferences?.extensions).settings);
      if (!settings || typeof settings !== "object") continue;

      for (const [id, extension] of Object.entries(settings)) {
        const value = record(extension);
        const name = String(record(value.manifest).name ?? "");
        const extensionPath = String(value.path ?? "");
        if (/opencode-browser-plugin|opencode-chromium/i.test(name) || /opencode-browser-plugin|opencode-chromium/i.test(extensionPath) || /Opencode-Plugins/i.test(extensionPath)) {
          ids.add(id);
        }
      }
    }
  }

  return [...ids];
}

function writeWrapper(targetDir: string, launcherPath: string) {
  const windows = process.platform === "win32";
  const wrapperPath = path.join(targetDir, windows ? "opencode-browser-host.cmd" : "opencode-browser-host");
  fs.writeFileSync(wrapperPath, windows
    ? `@echo off\r\n"${process.execPath}" "${launcherPath}"\r\n`
    : `#!/usr/bin/env sh\nexec "${process.execPath}" "${launcherPath}"\n`, { encoding: "utf8", mode: windows ? undefined : 0o755 });
  return wrapperPath;
}

function manifestPathForBrowser(browser: string, targetDir: string) {
  if (process.platform === "win32") return path.join(targetDir, `${HOST_NAME}.${BROWSERS[browser]?.engine === "gecko" ? "firefox" : browser}.json`);
  const manifestDir = nativeMessagingDir(browser);
  if (!manifestDir) return path.join(targetDir, `${HOST_NAME}.${browser}.json`);
  fs.mkdirSync(manifestDir, { recursive: true });
  return path.join(manifestDir, `${HOST_NAME}.json`);
}

function writeManifest({ browser, extensionIds, hostPath, targetDir }: { browser: string; extensionIds: string[]; hostPath: string; targetDir: string }) {
  const manifestPath = manifestPathForBrowser(browser, targetDir);
  const manifest = {
    name: HOST_NAME,
    description: "OpenCode browser native messaging host",
    path: hostPath,
    type: "stdio",
    ...(BROWSERS[browser]?.engine === "gecko" ? { allowed_extensions: [FIREFOX_EXTENSION_ID] } : { allowed_origins: extensionIds.map((extensionId: string) => `chrome-extension://${extensionId}/`) }),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

// Plan host files and registry entries before setup applies any changes.
export function planNativeHosts(targetDir = runtimeDir()) {
  const changes: FileChange[] = [], registry: RegistryChange[] = [], seen = new Set<string>();
  const hostPath = path.join(targetDir, process.platform === "win32" ? "opencode-browser-host.cmd" : "opencode-browser-host");
  const wrapper = process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${path.join(targetDir, "host.mjs")}"\r\n` : `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(targetDir, "host.mjs")}"\n`;
  const add = (filePath: string, after: string) => changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after });
  add(hostPath, wrapper);
  for (const browser of installedBrowsers()) {
    const ids = resolveExtensionIds({ browser, targetDir }).extensionIds;
    if (!ids.length && BROWSERS[browser]?.engine !== "gecko") ids.push("hdljmmpfnhojebplbbgdgejoobmjcbml");
    const id = BROWSERS[browser]?.engine === "gecko" ? "firefox" : browser;
    const filePath = process.platform === "win32" ? path.join(targetDir, `${HOST_NAME}.${id}.json`) : path.join(nativeMessagingDir(browser) ?? targetDir, `${HOST_NAME}.json`);
    if (seen.has(filePath)) continue; seen.add(filePath);
    add(filePath, JSON.stringify({ name: HOST_NAME, description: "OpenCode Browser native messaging host", path: hostPath, type: "stdio", ...(BROWSERS[browser]?.engine === "gecko" ? { allowed_extensions: [FIREFOX_EXTENSION_ID] } : { allowed_origins: ids.map(value => `chrome-extension://${value}/`) }) }, null, 2) + "\n");
    if (process.platform === "win32") registry.push({ key: requiredRegistryKey(browser), before: registryManifestPath(browser), after: filePath });
  }
  return { changes, registry, hostPath };
}
export function applyRegistryChanges(changes: RegistryChange[], restore = false) {
  const completed = [];
  try {
    for (const item of changes) {
      const value = restore ? item.before : item.after;
      if (value) execFileSync("reg", ["add", item.key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore", windowsHide: true });
      else execFileSync("reg", ["delete", item.key, "/ve", "/f"], { stdio: "ignore", windowsHide: true });
      completed.push(item);
    }
  } catch (error) {
    if (!restore) applyRegistryChanges(completed.reverse(), true);
    throw error;
  }
}

// A manifest's allowed origins, reduced to bare extension ids.
export function originIds(value: unknown): string[] {
  const manifest = record(value);
  const ids = manifest.allowed_extensions;
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === "string");
  const origins = manifest.allowed_origins;
  return Array.isArray(origins) ? origins.filter((origin): origin is string => typeof origin === "string").map(origin => origin.replace(/^chrome-extension:\/\//, "").replace(/\/$/, "")).filter(Boolean) : [];
}

// What the browser will actually load for a given browser, so callers can
// report registration instead of guessing from a file's existence. On Windows
// the registry entry is the registration; elsewhere the manifest's presence in
// the browser's own directory is.
export function readRegistration(browser: string, targetDir = runtimeDir()) {
  const browserDir = nativeMessagingDir(browser);
  const browserManifestPath = browserDir ? path.join(browserDir, `${HOST_NAME}.json`) : null;
  const useBrowserDirectory = process.platform !== "win32" && samePath(targetDir, runtimeDir()) && browserManifestPath && fs.existsSync(browserManifestPath);
  const manifestId = process.platform === "win32" && BROWSERS[browser]?.engine === "gecko" ? "firefox" : browser;
  const manifestPath = useBrowserDirectory ? browserManifestPath : path.join(targetDir, `${HOST_NAME}.${manifestId}.json`);
  const manifest = readJsonIfPresent(manifestPath);
  const valid = manifest !== null && manifest.name === HOST_NAME && typeof manifest.path === "string" && originIds(manifest).length > 0;
  const registered = valid && (process.platform === "win32" ? samePath(registryManifestPath(browser), manifestPath) : Boolean(useBrowserDirectory));
  return {
    browser,
    registered,
    manifestPath,
    hostPath: typeof manifest?.path === "string" ? manifest.path : null,
    extensionIds: originIds(manifest),
  };
}

function registryManifestPath(browser: string) {
  try {
    const output = execFileSync("reg", ["query", requiredRegistryKey(browser), "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.match(/REG_SZ\s+(.+?)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function writeExtensionIdConfig(targetDir: string, extensionIds: string[]) {
  if (extensionIds.length === 0) return null;
  const configPath = path.join(targetDir, "extension-ids.json");
  const uniqueIds = [...new Set(extensionIds)];
  const config: { extensionHostName: string; extensionIds: string[]; extensionId?: string } = {
    extensionHostName: HOST_NAME,
    extensionIds: uniqueIds,
  };
  if (uniqueIds.length === 1) config.extensionId = uniqueIds[0];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function installWindowsRegistry(browser: string, manifestPath: string) {
  const registryKey = requiredRegistryKey(browser);
  execFileSync("reg", ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// Which extension ids may talk to the host. Every source is consulted and the
// results merged, because each one can be incomplete: detection reads browser
// profiles, which fails whenever the browser is running and holding its
// preferences, and the recorded config may predate an extension. Narrowing to
// whichever source answered first would silently lock out a working extension.
export function resolveExtensionIds({ browser, extensionIds = [], noDetection = false, targetDir = runtimeDir() }: { browser: string; extensionIds?: string[]; noDetection?: boolean; targetDir?: string }) {
  if (BROWSERS[browser]?.engine === "gecko") return { extensionIds: [FIREFOX_EXTENSION_ID], source: "stable Firefox add-on ID" };
  if (extensionIds.length > 0) return { extensionIds, source: "argument" };
  const ids = new Set<string>();
  const sources = [];
  const existing = readRegistration(browser, targetDir).extensionIds;
  if (existing.length > 0) {
    existing.forEach((id: string) => ids.add(id));
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
  const rawIds: unknown[] = [...(Array.isArray(recorded?.extensionIds) ? recorded.extensionIds : []), recorded?.extensionId];
  const configured = rawIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (configured.length > 0) {
    configured.forEach((id) => ids.add(id));
    sources.push("scripts/extension-id.json");
  }
  return { extensionIds: [...ids], source: sources.join(" + ") || "none" };
}

export function installManifest(args: NativeHostOptions) {
  const root = repoRoot();
  // Honour a caller's directory instead of always writing to the live runtime
  // dir: a dry run or an isolated check must not overwrite the registration the
  // browser is currently using.
  const targetDir = args.targetDir ?? runtimeDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const hostPath = args.hostPath ?? writeWrapper(targetDir, path.join(root, "native-host", "dist", "runtime.js"));

  const installed = [];
  const skipped = [];
  const allExtensionIds: string[] = [];
  for (const browser of args.browsers) {
    const resolved = resolveExtensionIds({ browser, extensionIds: args.extensionIds, noDetection: args.noDetection, targetDir });
    if (resolved.extensionIds.length === 0) {
      skipped.push({ browser, reason: "no extension id known; load extension/ and pass --extension-id" });
      continue;
    }
    const manifestPath = writeManifest({ browser, extensionIds: resolved.extensionIds, hostPath, targetDir });
    if (process.platform === "win32") installWindowsRegistry(browser, manifestPath);
    installed.push({ browser, manifestPath, extensionIds: resolved.extensionIds, resolvedFrom: resolved.source });
    if (BROWSERS[browser]?.engine !== "gecko") allExtensionIds.push(...resolved.extensionIds);
  }

  const extensionIdConfigPath = writeExtensionIdConfig(targetDir, allExtensionIds);
  return { hostName: HOST_NAME, hostPath, extensionIdConfigPath, installed, skipped };
}

// A registration path comparison must ignore case and separator style.
function samePath(first: string|null, second: string) {
  if (typeof first !== "string" || typeof second !== "string") return false;
  return first.replaceAll("\\", "/").toLowerCase() === second.replaceAll("\\", "/").toLowerCase();
}

export { detectExtensionIds,installedBrowsers,parseArgs };

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

function requiredRegistryKey(browser: string): string { const key = windowsRegistryKey(browser, HOST_NAME); if (!key) throw new Error("Unsupported browser"); return key; }
