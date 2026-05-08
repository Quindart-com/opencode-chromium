#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ABOUT_BLANK_URL = "about:blank";
const USER_DATA_ENV = "OPENCODE_BROWSER_USER_DATA_DIR";
const PREFERENCES_ENV = "OPENCODE_BROWSER_PREFERENCES_PATH";

const BROWSERS = {
  chrome: {
    name: "Google Chrome",
    commands: ["chrome", "google-chrome"],
    windowsExecutables: ["Google\\Chrome\\Application\\chrome.exe"],
    macApps: ["Google Chrome.app"],
    linuxPaths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
    userData: {
      win32: ["Google", "Chrome", "User Data"],
      darwin: ["Library", "Application Support", "Google", "Chrome"],
      linux: [".config", "google-chrome"],
    },
  },
  edge: {
    name: "Microsoft Edge",
    commands: ["msedge", "microsoft-edge"],
    windowsExecutables: ["Microsoft\\Edge\\Application\\msedge.exe"],
    macApps: ["Microsoft Edge.app"],
    linuxPaths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    userData: {
      win32: ["Microsoft", "Edge", "User Data"],
      darwin: ["Library", "Application Support", "Microsoft Edge"],
      linux: [".config", "microsoft-edge"],
    },
  },
  brave: {
    name: "Brave Browser",
    commands: ["brave", "brave-browser"],
    windowsExecutables: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    macApps: ["Brave Browser.app"],
    linuxPaths: ["/usr/bin/brave", "/usr/bin/brave-browser"],
    userData: {
      win32: ["BraveSoftware", "Brave-Browser", "User Data"],
      darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
      linux: [".config", "BraveSoftware", "Brave-Browser"],
    },
  },
  chromium: {
    name: "Chromium",
    commands: ["chromium", "chromium-browser"],
    windowsExecutables: ["Chromium\\Application\\chrome.exe"],
    macApps: ["Chromium.app"],
    linuxPaths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
    userData: {
      win32: ["Chromium", "User Data"],
      darwin: ["Library", "Application Support", "Chromium"],
      linux: [".config", "chromium"],
    },
  },
};

function usage() {
  console.error("Usage: node scripts/open-browser-window.js [--browser chrome|edge|brave|chromium] [--url <url>] [--dry-run] [--json]");
  console.error(`Optional env: ${USER_DATA_ENV}, ${PREFERENCES_ENV}`);
}

function parseArgs(argv) {
  const args = { browser: "chrome", url: ABOUT_BLANK_URL, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--browser") args.browser = argv[++i];
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
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

function executableCandidates(browser) {
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
    for (const root of roots) {
      for (const relative of browser.windowsExecutables) candidates.push(path.join(root, relative));
    }
  } else if (process.platform === "darwin") {
    for (const root of ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")]) {
      for (const appName of browser.macApps) candidates.push(path.join(root, appName));
    }
  } else {
    candidates.push(...browser.linuxPaths);
  }

  for (const command of browser.commands) {
    const found = commandPath(command);
    if (found) candidates.push(found);
  }
  return candidates;
}

function resolveExecutable(browser) {
  return executableCandidates(browser).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function userDataRoot(browser) {
  if (process.env[USER_DATA_ENV]) return path.resolve(process.env[USER_DATA_ENV]);
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
    : os.homedir();
  return path.join(base, ...browser.userData[platform]);
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compareProfiles(first, second) {
  const key = (profile) => {
    if (profile === "Default") return 0;
    const match = profile.match(/^Profile (\d+)$/);
    return match ? Number(match[1]) : -1;
  };
  return key(first) - key(second);
}

function isUsableProfile(root, profile) {
  return typeof profile === "string" && profile.length > 0 && fs.existsSync(path.join(root, profile, "Preferences"));
}

function resolveProfileDirectory(root) {
  if (process.env[PREFERENCES_ENV]) return path.basename(path.dirname(path.resolve(process.env[PREFERENCES_ENV])));

  const localState = readJsonIfPresent(path.join(root, "Local State"));
  const ordered = [];
  if (typeof localState?.profile?.last_used === "string") ordered.push(localState.profile.last_used);
  if (Array.isArray(localState?.profile?.last_active_profiles)) ordered.push(...localState.profile.last_active_profiles);
  ordered.push("Default");

  if (fs.existsSync(root)) {
    const profiles = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Profile \d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareProfiles);
    ordered.push(...profiles);
  }

  return [...new Set(ordered)].find((profile) => isUsableProfile(root, profile)) ?? "Default";
}

function launchCommand(browserId, browser, executablePath, profileDirectory, url) {
  if (process.platform === "darwin" && executablePath.endsWith(".app")) {
    return {
      command: "open",
      args: ["-na", executablePath, "--args", `--profile-directory=${profileDirectory}`, url],
      browserId,
      executablePath,
      profileDirectory,
      url,
    };
  }

  return {
    command: executablePath,
    args: [`--profile-directory=${profileDirectory}`, url],
    browserId,
    executablePath,
    profileDirectory,
    url,
  };
}

function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

try {
  const args = parseArgs(process.argv.slice(2));
  const browser = BROWSERS[args.browser];
  const executablePath = resolveExecutable(browser);
  if (!executablePath) throw new Error(`${browser.name} executable was not found`);
  const root = userDataRoot(browser);
  const profileDirectory = resolveProfileDirectory(root);
  const command = launchCommand(args.browser, browser, executablePath, profileDirectory, args.url);

  if (args.json || args.dryRun) console.log(JSON.stringify({ ...command, userDataRoot: root, dryRun: args.dryRun }, null, 2));
  else console.log(`Opening ${browser.name} with profile ${profileDirectory}`);

  if (!args.dryRun) launch(command.command, command.args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
