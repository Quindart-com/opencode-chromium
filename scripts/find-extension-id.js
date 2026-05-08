#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSER_ROOTS = {
  brave: path.join(os.homedir(), "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"),
  chrome: path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"),
  edge: path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data"),
};

const browser = process.argv[2] ?? "brave";
const root = process.argv[3] ?? BROWSER_ROOTS[browser];

if (!root) {
  console.error(`Unknown browser: ${browser}`);
  process.exit(1);
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
