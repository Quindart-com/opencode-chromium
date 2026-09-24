#!/usr/bin/env node
// Verify the native messaging host is correctly registered. The inventory and
// registration reader live in src/cli so this agrees with `opencode-chromium
// link` and `status` by construction rather than by keeping tables in step.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { browserIds, installedBrowsers, nativeMessagingDir, windowsRegistryKey } from "../src/cli/browsers.js";
import { HOST_NAME, originIds, readRegistration, runtimeDir } from "../src/cli/native-host.js";

const EXTENSION_ID_ENV = "OPENCODE_BROWSER_EXTENSION_ID";
const MANIFEST_PATH_ENV = "OPENCODE_BROWSER_NATIVE_HOST_MANIFEST_PATH";

function usage() {
  console.error("Usage: node scripts/check-native-host.js [chrome,edge,brave,chromium] [--all] [--json] [--extension-id <id>]");
  console.error("Checks the browsers that are installed unless --all is given.");
  console.error(`Optional env: ${EXTENSION_ID_ENV}, ${MANIFEST_PATH_ENV}`);
}

function parseArgs(argv) {
  const args = { browsers: null, json: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--all") args.all = true;
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
  for (const browser of args.browsers ?? []) {
    if (!browserIds().includes(browser)) throw new Error(`Unsupported browser: ${browser}`);
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

function expectedExtensionIds(explicitId) {
  if (explicitId) return [explicitId];
  if (process.env[EXTENSION_ID_ENV]) return [process.env[EXTENSION_ID_ENV]];
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "extension-id.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (Array.isArray(config?.extensionIds)) return config.extensionIds.filter((id) => typeof id === "string");
    if (typeof config?.extensionId === "string") return [config.extensionId];
  } catch {
    // No recorded ids: the manifest's own origins are checked instead.
  }
  return [];
}

function checkBrowser(browser, extensionIds) {
  const registryKey = windowsRegistryKey(browser, HOST_NAME);
  const registryManifestPath = process.platform === "win32" ? readRegistryDefaultValue(registryKey) : null;
  const override = process.env[MANIFEST_PATH_ENV] ? path.resolve(process.env[MANIFEST_PATH_ENV]) : null;
  const manifestPath = override ?? path.join(process.platform === "win32" ? runtimeDir() : nativeMessagingDir(browser), `${HOST_NAME}${process.platform === "win32" ? `.${browser}` : ""}.json`);
  const registration = readRegistration(browser, runtimeDir());
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const allowedOrigins = originIds(manifest).map((id) => `chrome-extension://${id}/`);
  const missingOrigins = extensionIds.map((id) => `chrome-extension://${id}/`).filter((origin) => !allowedOrigins.includes(origin));
  const problems = [];

  if (process.platform === "win32" && !registryManifestPath) problems.push(`Missing registry key: ${registryKey}`);
  if (!fs.existsSync(manifestPath)) problems.push(`Manifest does not exist: ${manifestPath}`);
  if (manifest && manifest.name !== HOST_NAME) problems.push(`Expected manifest name ${HOST_NAME}`);
  if (manifest?.path && !fs.existsSync(manifest.path)) problems.push(`Host executable does not exist: ${manifest.path}`);
  if (manifest && extensionIds.length > 0 && missingOrigins.length > 0) problems.push(`Missing allowed origins: ${missingOrigins.join(", ")}`);

  return {
    browser,
    registryKey,
    registryManifestPath,
    manifestPath,
    exists: fs.existsSync(manifestPath),
    registered: registration.registered,
    correct: problems.length === 0,
    problem: problems.join("; ") || null,
    expectedHostName: HOST_NAME,
    expectedExtensionIds: extensionIds,
    allowedOrigins,
    hostPath: manifest?.path ?? null,
    hostExists: manifest?.path ? fs.existsSync(manifest.path) : false,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const installed = installedBrowsers();
  const browsers = args.browsers ?? (args.all ? browserIds() : installed);
  const results = browsers.map((browser) => checkBrowser(browser, expectedExtensionIds(args.extensionId)));
  const skipped = browserIds().filter((browser) => !browsers.includes(browser));
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of results) console.log(`${result.browser}: ${result.correct ? "correct" : result.problem}`);
    if (skipped.length > 0) console.log(`not installed, skipped: ${skipped.join(", ")} (use --all to check anyway)`);
  }
  process.exit(results.every((result) => result.correct) ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
