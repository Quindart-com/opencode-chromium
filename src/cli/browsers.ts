import fs from "node:fs";
import { existingFile,findExecutable,windowsAppPath } from "../management/executable-discovery.ts";
import os from "node:os";
import path from "node:path";

// One browser inventory. Where a browser keeps its profile, its native
// messaging registration and its executable are the same facts whoever asks, so
// they are described once here instead of in a table per script.
export type BrowserId = "firefox" | "librewolf" | "chrome" | "edge" | "brave" | "chromium";
type PlatformKey = "win32" | "darwin" | "linux";
interface BrowserDefinition {
  name: string;
  engine?: "gecko";
  registryRoot: string;
  commands: string[];
  windowsExecutables: string[];
  macApps: [string, ...string[]];
  linuxPaths: string[];
  userDataDir: Record<PlatformKey, string[]>;
  nativeMessagingDir: Partial<Record<PlatformKey, string[]>>;
}
export const BROWSERS: Record<BrowserId, BrowserDefinition> & Partial<Record<string, BrowserDefinition>> = {
  firefox: {
    name: "Firefox", engine: "gecko", registryRoot: "Mozilla", commands: ["firefox"],
    windowsExecutables: ["Mozilla Firefox\\firefox.exe"], macApps: ["Firefox.app"], linuxPaths: ["/usr/bin/firefox"],
    userDataDir: { win32: ["Mozilla", "Firefox"], darwin: ["Library", "Application Support", "Firefox"], linux: [".mozilla", "firefox"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "Mozilla", "NativeMessagingHosts"], linux: [".mozilla", "native-messaging-hosts"] },
  },
  librewolf: {
    name: "LibreWolf", engine: "gecko", registryRoot: "Mozilla", commands: ["librewolf"],
    windowsExecutables: ["LibreWolf\\librewolf.exe"], macApps: ["LibreWolf.app"], linuxPaths: ["/usr/bin/librewolf"],
    userDataDir: { win32: ["librewolf"], darwin: ["Library", "Application Support", "librewolf"], linux: [".librewolf"] },
    nativeMessagingDir: { darwin: ["Library", "Application Support", "Mozilla", "NativeMessagingHosts"], linux: [".mozilla", "native-messaging-hosts"] },
  },
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

export function browserIds(): BrowserId[] {
  return Object.keys(BROWSERS) as BrowserId[];
}

function platformKey() {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

function localAppData() {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

const browserEnv = (browser: string, suffix: string) => process.env["OPENCODE_BROWSER_" + browser.toUpperCase() + "_" + suffix];

export function browserUserDataRoot(browser: string) {
  const override = BROWSERS[browser] && browserEnv(browser, "USER_DATA_DIR");
  if (override) return path.resolve(override);
  const parts = BROWSERS[browser]?.userDataDir[platformKey()];
  if (!parts) return null;
  return process.platform === "win32" ? path.join(BROWSERS[browser]?.engine === "gecko" ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming") : localAppData(), ...parts) : process.platform === "linux" && parts[0] === ".config" ? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), ...parts.slice(1)) : path.join(os.homedir(), ...parts);
}

export function nativeMessagingDir(browser: string) {
  const override = BROWSERS[browser] && browserEnv(browser, "NATIVE_MESSAGING_DIR");
  if (override && process.platform !== "win32") return path.resolve(override);
  const browser_ = BROWSERS[browser];
  if (!browser_) return null;
  if (process.platform === "win32") return null;
  const parts = browser_.nativeMessagingDir[platformKey()];
  return parts ? process.platform === "linux" && parts[0] === ".config" ? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), ...parts.slice(1)) : path.join(os.homedir(), ...parts) : null;
}

export function windowsRegistryKey(browser: string, hostName: string) {
  const root = BROWSERS[browser]?.registryRoot;
  return root ? `HKCU\\Software\\${root}\\NativeMessagingHosts\\${hostName}` : null;
}

export function executableCandidates(browser: string) {
  const entry = BROWSERS[browser];
  if (!entry) return [];
  const override = browserEnv(browser, "EXECUTABLE");
  if (override) return existingFile(override) ? [path.resolve(override)] : [];
  const onPath = entry.commands.map(findExecutable).filter((value): value is string => value !== null);
  if (process.platform === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter((value): value is string => typeof value === "string" && value.length > 0);
    return [...entry.windowsExecutables.map(relative => windowsAppPath(path.win32.basename(relative))).filter((value): value is string => !!value), ...roots.flatMap((root) => entry.windowsExecutables.map((relative: string) => path.join(root, relative))), ...onPath];
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
