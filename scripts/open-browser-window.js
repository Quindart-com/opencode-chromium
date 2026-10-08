#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ABOUT_BLANK_URL = "about:blank";
const USER_DATA_ENV = "OPENCODE_BROWSER_USER_DATA_DIR";
const PREFERENCES_ENV = "OPENCODE_BROWSER_PREFERENCES_PATH";

import { BROWSERS, executableCandidates as browserExecutables, browserUserDataRoot } from "../src/cli/browsers.js";
import { firefoxProfiles } from "../src/cli/firefox-profiles.js";

function usage() {
  console.error("Usage: node scripts/open-browser-window.js [--browser chrome|edge|brave|chromium|firefox|librewolf] [--url <url>] [--dry-run] [--json]");
  console.error(`Optional env: ${USER_DATA_ENV}, ${PREFERENCES_ENV}`);
}

function parseArgs(argv) {
  const args = { browser: "chrome", url: ABOUT_BLANK_URL, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--browser") args.browser = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
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

function resolveExecutable(browser) {
  return browserExecutables(browser).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function userDataRoot(browser) {
  if (process.env[USER_DATA_ENV]) return path.resolve(process.env[USER_DATA_ENV]);
  return browserUserDataRoot(browser);
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
  const executablePath = resolveExecutable(args.browser);
  if (!executablePath) throw new Error(`${browser.name} executable was not found`);
  const root = userDataRoot(args.browser);
  const profileDirectory = browser.engine === "gecko" ? (args.profile ? path.resolve(args.profile) : firefoxProfiles(root)[0]?.path) : (args.profile ?? resolveProfileDirectory(root));
  if (!profileDirectory) throw new Error("No Firefox profile found; specify --profile /absolute/profile/path");
  let command = launchCommand(args.browser, browser, executablePath, profileDirectory, args.url);
  if (browser.engine === "gecko") {
    const launchArgs = ["--profile", profileDirectory, args.url];
    if (args.port !== undefined) {
      if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error("Choose a port between 1024 and 65535");
      if (["parent.lock", ".parentlock", "lock"].some(name => fs.existsSync(path.join(profileDirectory, name)))) throw new Error("Selected profile may already be occupied; close it yourself before changing launch configuration");
      launchArgs.unshift("--no-remote", "--remote-debugging-port", String(args.port));
    }
    command.args = process.platform === "darwin" && executablePath.endsWith(".app") ? ["-na", executablePath, "--args", ...launchArgs] : launchArgs;
  }

  if (args.json || args.dryRun) console.log(JSON.stringify({ ...command, userDataRoot: root, dryRun: args.dryRun }, null, 2));
  else console.log(`Opening ${browser.name} with profile ${profileDirectory}`);

  if (!args.dryRun) launch(command.command, command.args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
