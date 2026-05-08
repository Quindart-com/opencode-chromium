#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.opencode.browser";
const SUPPORTED_BROWSERS = {
  chrome: {
    windowsRegistryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    windowsUserDataDir: ["Google", "Chrome", "User Data"],
  },
  edge: {
    windowsRegistryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    windowsUserDataDir: ["Microsoft", "Edge", "User Data"],
  },
  brave: {
    windowsRegistryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
    windowsUserDataDir: ["BraveSoftware", "Brave-Browser", "User Data"],
  },
  chromium: {
    windowsRegistryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    windowsUserDataDir: ["Chromium", "User Data"],
  },
};

function usage() {
  console.error("Usage: node scripts/install-native-host.js [--auto] [--extension-id <id>] [--browsers chrome,edge,brave,chromium|all]");
  console.error("");
  console.error("The extension ID is visible on chrome://extensions after loading extension/ as unpacked.");
}

function parseArgs(argv) {
  const args = { browsers: ["chrome"] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--extension-id") {
      args.extensionId = argv[++i];
      continue;
    }
    if (arg === "--auto") {
      args.auto = true;
      args.browsers = Object.keys(SUPPORTED_BROWSERS);
      continue;
    }
    if (arg === "--browsers") {
      const browsers = argv[++i].split(",").map((item) => item.trim()).filter(Boolean);
      args.browsers = browsers.includes("all") ? Object.keys(SUPPORTED_BROWSERS) : browsers;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.extensionId) args.extensionId = process.env.OPENCODE_BROWSER_EXTENSION_ID;
  if (!args.extensionId && !args.auto) throw new Error("Missing --extension-id, OPENCODE_BROWSER_EXTENSION_ID, or --auto");
  for (const browser of args.browsers) {
    if (!SUPPORTED_BROWSERS[browser]) throw new Error(`Unsupported browser: ${browser}`);
  }
  return args;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function installDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser");
  }
  return path.join(os.homedir(), ".config", "opencode", "browser");
}

function browserUserDataRoot(browser) {
  if (process.platform !== "win32") return null;
  const parts = SUPPORTED_BROWSERS[browser].windowsUserDataDir;
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), ...parts);
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
        if (/OpenCode Browser/i.test(name) || /Opencode-Plugins/i.test(extensionPath) || /opencode/i.test(extensionPath)) {
          ids.add(id);
        }
      }
    }
  }

  return [...ids];
}

function writeWindowsWrapper(root, targetDir) {
  const wrapperPath = path.join(targetDir, "opencode-browser-host.cmd");
  const hostPath = path.join(root, "native-host", "src", "host.js");
  const contents = `@echo off\r\n"${process.execPath}" "${hostPath}"\r\n`;
  fs.writeFileSync(wrapperPath, contents, "utf8");
  return wrapperPath;
}

function writeUnixWrapper(root, targetDir) {
  const wrapperPath = path.join(targetDir, "opencode-browser-host");
  const hostPath = path.join(root, "native-host", "src", "host.js");
  const contents = `#!/usr/bin/env sh\nexec "${process.execPath}" "${hostPath}"\n`;
  fs.writeFileSync(wrapperPath, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function manifestPathForBrowser(browser, targetDir) {
  return path.join(targetDir, `${HOST_NAME}.${browser}.json`);
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

function installWindowsRegistry(browser, manifestPath) {
  const registryKey = SUPPORTED_BROWSERS[browser].windowsRegistryKey;
  execFileSync("reg", ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function installManifest(args) {
  const root = repoRoot();
  const targetDir = installDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const hostPath = process.platform === "win32" ? writeWindowsWrapper(root, targetDir) : writeUnixWrapper(root, targetDir);

  const installed = [];
  for (const browser of args.browsers) {
    const extensionIds = args.auto ? detectExtensionIds(browser) : [args.extensionId];
    if (extensionIds.length === 0) {
      installed.push({ browser, skipped: true, reason: "OpenCode Browser extension was not detected" });
      continue;
    }

    const manifestPath = writeManifest({
      browser,
      extensionIds,
      hostPath,
      targetDir,
    });

    if (process.platform === "win32") installWindowsRegistry(browser, manifestPath);
    installed.push({ browser, manifestPath, extensionIds });
  }

  return { hostName: HOST_NAME, hostPath, installed };
}

try {
  const result = installManifest(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
