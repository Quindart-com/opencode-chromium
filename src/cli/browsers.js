import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// One browser inventory. Where a browser keeps its profile, its native
// messaging registration and its executable are the same facts whoever asks, so
// they are described once here instead of in a table per script.
export const BROWSERS = {
  chrome: {
    name: "Google Chrome",
    registryRoot: "Google\\Chrome",
    commands: ["chrome", "google-chrome"],
    windowsExecutables: ["Google\\Chrome\\Application\\chrome.exe"],
    macApps: ["Google Chrome.app"],
    linuxPaths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
    userDataDir: { win32: ["Google", "Chrome", "User Data"], darwin: ["Library", "Application Support", "Google", "Chrome"], linux: [".config", "google-chrome"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"], linux: [".config", "google-chrome", "NativeMessagingHosts"] },
  },
  edge: {
    name: "Microsoft Edge",
    registryRoot: "Microsoft\\Edge",
    commands: ["msedge", "microsoft-edge"],
    windowsExecutables: ["Microsoft\\Edge\\Application\\msedge.exe"],
    macApps: ["Microsoft Edge.app"],
    linuxPaths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    userDataDir: { win32: ["Microsoft", "Edge", "User Data"], darwin: ["Library", "Application Support", "Microsoft Edge"], linux: [".config", "microsoft-edge"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"], linux: [".config", "microsoft-edge", "NativeMessagingHosts"] },
  },
  brave: {
    name: "Brave",
    registryRoot: "BraveSoftware\\Brave-Browser",
    commands: ["brave", "brave-browser"],
    windowsExecutables: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    macApps: ["Brave Browser.app"],
    linuxPaths: ["/usr/bin/brave", "/usr/bin/brave-browser"],
    userDataDir: { win32: ["BraveSoftware", "Brave-Browser", "User Data"], darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"], linux: [".config", "BraveSoftware", "Brave-Browser"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"], linux: [".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"] },
  },
  chromium: {
    name: "Chromium",
    registryRoot: "Chromium",
    commands: ["chromium", "chromium-browser"],
    windowsExecutables: ["Chromium\\Application\\chrome.exe"],
    macApps: ["Chromium.app"],
    linuxPaths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
    userDataDir: { win32: ["Chromium", "User Data"], darwin: ["Library", "Application Support", "Chromium"], linux: [".config", "chromium"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"], linux: [".config", "chromium", "NativeMessagingHosts"] },
  },
};

export function browserIds() {
  return Object.keys(BROWSERS);
}

function platformKey() {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

function localAppData() {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

export function browserUserDataRoot(browser) {
  const parts = BROWSERS[browser]?.userDataDir[platformKey()];
  if (!parts) return null;
  return process.platform === "win32" ? path.join(localAppData(), ...parts) : path.join(os.homedir(), ...parts);
}

export function nativeMessagingDir(browser) {
  const browser_ = BROWSERS[browser];
  if (!browser_) return null;
  if (process.platform === "win32") return null;
  const parts = browser_.nativeMessagingDir[platformKey()];
  return parts ? path.join(os.homedir(), ...parts) : null;
}

export function windowsRegistryKey(browser, hostName) {
  const root = BROWSERS[browser]?.registryRoot;
  return root ? `HKCU\\Software\\${root}\\NativeMessagingHosts\\${hostName}` : null;
}

function commandPath(command) {
  const executable = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(executable, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export function executableCandidates(browser) {
  const entry = BROWSERS[browser];
  if (!entry) return [];
  const onPath = entry.commands.map(commandPath).filter(Boolean);
  if (process.platform === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
    return [...roots.flatMap((root) => entry.windowsExecutables.map((relative) => path.join(root, relative))), ...onPath];
  }
  if (process.platform === "darwin") {
    return [...["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")].map((root) => path.join(root, entry.macApps[0])), ...onPath];
  }
  return [...entry.linuxPaths, ...onPath];
}

export function installedBrowsers() {
  return browserIds().filter((browser) => {
    const executable = executableCandidates(browser).find((candidate) => fs.existsSync(candidate));
    return Boolean(executable);
  });
}

export function describeInstalledBrowsers() {
  return browserIds().map((id) => {
    const executablePath = executableCandidates(id).find((candidate) => fs.existsSync(candidate)) ?? null;
    return { id, name: BROWSERS[id].name, installed: Boolean(executablePath), executablePath };
  });
}
