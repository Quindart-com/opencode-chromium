#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOST_NAME = "com.opencode.browser";
const WINDOWS_REGISTRY_KEYS = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  chromium: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
};

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

function defaultManifestDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser");
  }
  return path.join(os.homedir(), ".config", "opencode", "browser");
}

function checkBrowser(browser) {
  const registryKey = WINDOWS_REGISTRY_KEYS[browser];
  const registryManifestPath = process.platform === "win32" ? readRegistryDefaultValue(registryKey) : null;
  const manifestPath = registryManifestPath ?? path.join(defaultManifestDir(), `${HOST_NAME}.${browser}.json`);
  const exists = fs.existsSync(manifestPath);
  const manifest = exists ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  return {
    browser,
    registryKey,
    registryManifestPath,
    manifestPath,
    exists,
    correctName: manifest?.name === HOST_NAME,
    hostPath: manifest?.path ?? null,
    hostExists: manifest?.path ? fs.existsSync(manifest.path) : false,
    allowedOrigins: manifest?.allowed_origins ?? [],
  };
}

const browsers = (process.argv[2] ?? "chrome,edge,brave,chromium")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

console.log(JSON.stringify(browsers.map(checkBrowser), null, 2));
