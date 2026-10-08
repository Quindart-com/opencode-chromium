#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = "extension-id.json";
const EXTENSION_ID_ENV = "OPENCODE_BROWSER_EXTENSION_ID";
const USER_DATA_ENV = "OPENCODE_BROWSER_USER_DATA_DIR";
const PREFERENCES_ENV = "OPENCODE_BROWSER_PREFERENCES_PATH";

import { BROWSERS, browserUserDataRoot } from "../src/cli/browsers.js";
import { firefoxProfiles } from "../src/cli/firefox-profiles.js";

function usage() {
  console.error("Usage: node scripts/check-extension-installed.js [--browser chrome|edge|brave|chromium|firefox|librewolf] [--extension-id <id>] [--json]");
  console.error(`Optional env: ${EXTENSION_ID_ENV}, ${USER_DATA_ENV}, ${PREFERENCES_ENV}`);
}

function parseArgs(argv) {
  const args = { browser: "chrome", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--browser") args.browser = argv[++i];
    else if (arg === "--extension-id") args.extensionId = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!BROWSERS[args.browser]) throw new Error(`Unsupported browser: ${args.browser}`);
  return args;
}

function scriptConfigPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), CONFIG_FILE);
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function configuredExtensionIds(explicitId) {
  if (explicitId) return [explicitId];
  if (process.env[EXTENSION_ID_ENV]) return [process.env[EXTENSION_ID_ENV]];
  const config = readJsonIfPresent(scriptConfigPath());
  if (typeof config?.extensionId === "string") return [config.extensionId];
  if (Array.isArray(config?.extensionIds)) return config.extensionIds.filter((id) => typeof id === "string");
  return [];
}

function userDataRoot(browser) {
  if (process.env[USER_DATA_ENV]) return path.resolve(process.env[USER_DATA_ENV]);
  return browserUserDataRoot(browser);
}

function profileDirectories(root) {
  if (!fs.existsSync(root)) return [];
  const localState = readJsonIfPresent(path.join(root, "Local State"));
  const ordered = [];
  if (typeof localState?.profile?.last_used === "string") ordered.push(localState.profile.last_used);
  if (Array.isArray(localState?.profile?.last_active_profiles)) ordered.push(...localState.profile.last_active_profiles);
  ordered.push("Default");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^Profile \d+$/.test(entry.name)) ordered.push(entry.name);
  }
  return [...new Set(ordered)].filter((profile) => fs.existsSync(path.join(root, profile, "Preferences")));
}

function preferencePaths(root) {
  if (process.env[PREFERENCES_ENV]) return [path.resolve(process.env[PREFERENCES_ENV])];
  return profileDirectories(root).flatMap((profile) => [
    path.join(root, profile, "Secure Preferences"),
    path.join(root, profile, "Preferences"),
  ]);
}

function extensionMatches(id, extension, expectedIds) {
  if (expectedIds.length > 0) return expectedIds.includes(id);
  const name = extension?.manifest?.name ?? "";
  const extensionPath = extension?.path ?? "";
  return /opencode-browser-plugin/i.test(name) || /opencode-browser-plugin/i.test(extensionPath) || /Opencode-Plugins/i.test(extensionPath);
}

function inspect(browser, explicitId) {
  const root = userDataRoot(browser);
  const expectedIds = BROWSERS[browser].engine === "gecko" ? [explicitId ?? "opencode-browser-plugin@quindart.com"] : configuredExtensionIds(explicitId);
  const matches = [];
  const paths = BROWSERS[browser].engine === "gecko" ? firefoxProfiles(root).map(profile => path.join(profile.path, "extensions.json")) : preferencePaths(root);
  for (const preferencesPath of paths) {
    const preferences = readJsonIfPresent(preferencesPath);
    const settings = BROWSERS[browser].engine === "gecko" ? Object.fromEntries((preferences?.addons ?? []).filter(addon => expectedIds.includes(addon.id)).map(addon => [addon.id, { manifest: { name: addon.defaultLocale?.name }, path: addon.path, state: addon.active ? 1 : 0 }])) : preferences?.extensions?.settings;
    if (!settings || typeof settings !== "object") continue;
    for (const [id, extension] of Object.entries(settings)) {
      if (!extensionMatches(id, extension, expectedIds)) continue;
      const disabled = extension.state === 0 || Object.keys(extension.disable_reasons ?? {}).length > 0;
      matches.push({
        id,
        name: extension?.manifest?.name ?? null,
        path: extension?.path ?? null,
        preferencesPath,
        profilePath: path.dirname(preferencesPath),
        registered: true,
        enabled: !disabled,
        state: extension.state ?? null,
        disableReasons: extension.disable_reasons ?? null,
      });
    }
  }
  const installed = matches.length > 0;
  const enabled = matches.some((match) => match.enabled);
  return {
    browser,
    userDataRoot: root,
    expectedIds,
    installed,
    enabled,
    exitCode: enabled ? 0 : installed ? 1 : 2,
    matches,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = inspect(args.browser, args.extensionId);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.enabled) console.log(`opencode-browser-plugin extension is installed and enabled in ${args.browser}`);
  else if (result.installed) console.log(`opencode-browser-plugin extension is installed but not enabled in ${args.browser}`);
  else console.log(`opencode-browser-plugin extension was not found in ${args.browser}`);
  process.exit(result.exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(3);
}
