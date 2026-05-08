#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.opencode.browser";
const EXTENSION_ID_ENV = "OPENCODE_BROWSER_EXTENSION_ID";
const MANIFEST_PATH_ENV = "OPENCODE_BROWSER_NATIVE_HOST_MANIFEST_PATH";
const WINDOWS_REGISTRY_KEYS = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  chromium: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
};
const NON_WINDOWS_MANIFEST_DIRS = {
  chrome: {
    darwin: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
    linux: [".config", "google-chrome", "NativeMessagingHosts"],
  },
  edge: {
    darwin: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"],
    linux: [".config", "microsoft-edge", "NativeMessagingHosts"],
  },
  brave: {
    darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
    linux: [".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
  },
  chromium: {
    darwin: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"],
    linux: [".config", "chromium", "NativeMessagingHosts"],
  },
};

function usage() {
  console.error("Usage: node scripts/check-native-host.js [chrome,edge,brave,chromium] [--json] [--extension-id <id>]");
  console.error(`Optional env: ${EXTENSION_ID_ENV}, ${MANIFEST_PATH_ENV}`);
}

function parseArgs(argv) {
  const args = { browsers: ["chrome", "edge", "brave", "chromium"], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--extension-id") args.extensionId = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      args.browsers = arg.split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const browser of args.browsers) {
    if (!WINDOWS_REGISTRY_KEYS[browser]) throw new Error(`Unsupported browser: ${browser}`);
  }
  return args;
}

function readRegistryDefaultValue(key) {
  try {
    const output = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*\(Default\)\s+REG_\w+\s+(.+?)\s*$/);
      if (match) return match[1].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    return null;
  }
  return null;
}

function defaultManifestDir(browser) {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser");
  }
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return path.join(os.homedir(), ...NON_WINDOWS_MANIFEST_DIRS[browser][platform]);
}

function fallbackManifestDir() {
  if (process.platform === "win32") return null;
  return path.join(os.homedir(), ".config", "opencode", "browser");
}

function configPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "extension-id.json");
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function expectedExtensionIds(explicitId) {
  if (explicitId) return [explicitId];
  if (process.env[EXTENSION_ID_ENV]) return [process.env[EXTENSION_ID_ENV]];
  const config = readJsonIfPresent(configPath());
  if (typeof config?.extensionId === "string") return [config.extensionId];
  if (Array.isArray(config?.extensionIds)) return config.extensionIds.filter((id) => typeof id === "string");
  return [];
}

function manifestPathForBrowser(browser) {
  if (process.env[MANIFEST_PATH_ENV]) return path.resolve(process.env[MANIFEST_PATH_ENV]);
  const registryManifestPath = process.platform === "win32" ? readRegistryDefaultValue(WINDOWS_REGISTRY_KEYS[browser]) : null;
  if (registryManifestPath) return registryManifestPath;
  const standardFile = process.platform === "win32" ? `${HOST_NAME}.${browser}.json` : `${HOST_NAME}.json`;
  const standardPath = path.join(defaultManifestDir(browser), standardFile);
  if (fs.existsSync(standardPath)) return standardPath;
  const fallbackDir = fallbackManifestDir();
  return fallbackDir ? path.join(fallbackDir, `${HOST_NAME}.${browser}.json`) : standardPath;
}

function checkBrowser(browser, extensionIds) {
  const registryKey = WINDOWS_REGISTRY_KEYS[browser];
  const registryManifestPath = process.platform === "win32" ? readRegistryDefaultValue(registryKey) : null;
  const manifestPath = manifestPathForBrowser(browser);
  const exists = fs.existsSync(manifestPath);
  const manifest = exists ? readJsonIfPresent(manifestPath) : null;
  const expectedOrigins = extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`);
  const allowedOrigins = manifest?.allowed_origins ?? [];
  const missingOrigins = expectedOrigins.filter((origin) => !allowedOrigins.includes(origin));
  const problems = [];

  if (process.platform === "win32" && !registryManifestPath) problems.push(`Missing registry key: ${registryKey}`);
  if (!exists) problems.push(`Manifest does not exist: ${manifestPath}`);
  if (exists && manifest?.name !== HOST_NAME) problems.push(`Expected manifest name ${HOST_NAME}`);
  if (exists && manifest?.path && !fs.existsSync(manifest.path)) problems.push(`Host executable does not exist: ${manifest.path}`);
  if (exists && expectedOrigins.length > 0 && missingOrigins.length > 0) problems.push(`Missing allowed origins: ${missingOrigins.join(", ")}`);

  return {
    browser,
    registryKey,
    registryManifestPath,
    manifestPath,
    exists,
    correct: problems.length === 0,
    problem: problems.join("; ") || null,
    expectedHostName: HOST_NAME,
    expectedExtensionIds: extensionIds,
    expectedOrigins,
    allowedOrigins,
    hostPath: manifest?.path ?? null,
    hostExists: manifest?.path ? fs.existsSync(manifest.path) : false,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const extensionIds = expectedExtensionIds(args.extensionId);
  const results = args.browsers.map((browser) => checkBrowser(browser, extensionIds));
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of results) {
      console.log(`${result.browser}: ${result.correct ? "correct" : result.problem}`);
    }
  }
  process.exit(results.every((result) => result.correct) ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
