#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSER_ROOTS = {
  brave: {
    win32: path.join(os.homedir(), "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"),
    darwin: path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    linux: path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser"),
  },
  chrome: {
    win32: path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"),
    darwin: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    linux: path.join(os.homedir(), ".config", "google-chrome"),
  },
  edge: {
    win32: path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data"),
    darwin: path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge"),
    linux: path.join(os.homedir(), ".config", "microsoft-edge"),
  },
  chromium: {
    win32: path.join(os.homedir(), "AppData", "Local", "Chromium", "User Data"),
    darwin: path.join(os.homedir(), "Library", "Application Support", "Chromium"),
    linux: path.join(os.homedir(), ".config", "chromium"),
  },
};

const browser = process.argv[2] ?? "brave";
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const root = process.argv[3] ?? BROWSER_ROOTS[browser]?.[platform];

if (!root) {
  console.error(`Unknown browser: ${browser}`);
  process.exit(1);
}

if (!fs.existsSync(root)) {
  console.log(JSON.stringify([], null, 2));
  process.exit(0);
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const results = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const profile = entry.name;
  for (const preferencesFile of ["Secure Preferences", "Preferences"]) {
    const preferences = readJsonIfPresent(path.join(root, profile, preferencesFile));
    const settings = preferences?.extensions?.settings;
    if (!settings || typeof settings !== "object") continue;

    for (const [id, extension] of Object.entries(settings)) {
      const name = extension?.manifest?.name ?? "";
      const extensionPath = extension?.path ?? "";
      const matches =
        /OpenCode Browser/i.test(name) ||
        /Opencode-Plugins/i.test(extensionPath) ||
        /opencode/i.test(extensionPath);
      if (!matches) continue;

      results.push({
        browser,
        profile,
        preferencesFile,
        id,
        name,
        path: extensionPath,
        enabled: extension.state !== 0,
        location: extension.location ?? null,
      });
    }
  }
}

console.log(JSON.stringify(results, null, 2));
