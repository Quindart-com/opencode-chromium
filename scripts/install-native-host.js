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
  },
  edge: {
    windowsRegistryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  },
  brave: {
    windowsRegistryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  },
  chromium: {
    windowsRegistryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
  },
};

function usage() {
  console.error("Usage: node scripts/install-native-host.js --extension-id <id> [--browsers chrome,edge,brave,chromium]");
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
    if (arg === "--browsers") {
      args.browsers = argv[++i].split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.extensionId) args.extensionId = process.env.OPENCODE_BROWSER_EXTENSION_ID;
  if (!args.extensionId) throw new Error("Missing --extension-id or OPENCODE_BROWSER_EXTENSION_ID");
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

function writeWindowsWrapper(root, targetDir) {
  const wrapperPath = path.join(targetDir, "opencode-browser-host.cmd");
  const hostPath = path.join(root, "native-host", "src", "host.js");
  const contents = `@echo off\r\nnode "${hostPath}"\r\n`;
  fs.writeFileSync(wrapperPath, contents, "utf8");
  return wrapperPath;
}

function writeUnixWrapper(root, targetDir) {
  const wrapperPath = path.join(targetDir, "opencode-browser-host");
  const hostPath = path.join(root, "native-host", "src", "host.js");
  const contents = `#!/usr/bin/env sh\nexec node "${hostPath}"\n`;
  fs.writeFileSync(wrapperPath, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function manifestPathForBrowser(browser, targetDir) {
  return path.join(targetDir, `${HOST_NAME}.${browser}.json`);
}

function writeManifest({ browser, extensionId, hostPath, targetDir }) {
  const manifestPath = manifestPathForBrowser(browser, targetDir);
  const manifest = {
    name: HOST_NAME,
    description: "OpenCode Chromium browser native messaging host",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
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
    const manifestPath = writeManifest({
      browser,
      extensionId: args.extensionId,
      hostPath,
      targetDir,
    });

    if (process.platform === "win32") installWindowsRegistry(browser, manifestPath);
    installed.push({ browser, manifestPath });
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
