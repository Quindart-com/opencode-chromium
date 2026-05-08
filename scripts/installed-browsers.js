#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BROWSERS = {
  chrome: {
    name: "Google Chrome",
    commands: ["chrome", "google-chrome"],
    windowsExecutables: ["Google\\Chrome\\Application\\chrome.exe"],
    macApps: ["Google Chrome.app"],
    linuxPaths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  },
  edge: {
    name: "Microsoft Edge",
    commands: ["msedge", "microsoft-edge"],
    windowsExecutables: ["Microsoft\\Edge\\Application\\msedge.exe"],
    macApps: ["Microsoft Edge.app"],
    linuxPaths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
  },
  brave: {
    name: "Brave",
    commands: ["brave", "brave-browser"],
    windowsExecutables: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    macApps: ["Brave Browser.app"],
    linuxPaths: ["/usr/bin/brave", "/usr/bin/brave-browser"],
  },
  chromium: {
    name: "Chromium",
    commands: ["chromium", "chromium-browser"],
    windowsExecutables: ["Chromium\\Application\\chrome.exe"],
    macApps: ["Chromium.app"],
    linuxPaths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
  },
};

function usage() {
  console.error("Usage: node scripts/installed-browsers.js [--json] [--check]");
}

function parseArgs(argv) {
  const args = { json: false, check: false };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
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

function windowsCandidates(browser) {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const relative of browser.windowsExecutables) candidates.push(path.join(root, relative));
  }
  for (const command of browser.commands) {
    const found = commandPath(command);
    if (found) candidates.push(found);
  }
  return candidates;
}

function macCandidates(browser) {
  const roots = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")];
  const candidates = [];
  for (const root of roots) {
    for (const appName of browser.macApps) candidates.push(path.join(root, appName));
  }
  return candidates;
}

function linuxCandidates(browser) {
  const candidates = [...browser.linuxPaths];
  for (const command of browser.commands) {
    const found = commandPath(command);
    if (found) candidates.push(found);
  }
  return candidates;
}

function browserCandidates(browser) {
  if (process.platform === "win32") return windowsCandidates(browser);
  if (process.platform === "darwin") return macCandidates(browser);
  return linuxCandidates(browser);
}

function installedBrowser(id, browser) {
  const executablePath = browserCandidates(browser).find((candidate) => fs.existsSync(candidate)) ?? null;
  return { id, name: browser.name, installed: Boolean(executablePath), executablePath };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const browsers = Object.entries(BROWSERS).map(([id, browser]) => installedBrowser(id, browser));
  const result = { platform: process.platform, browsers };
  if (args.json || args.check) console.log(JSON.stringify(result, null, 2));
  else {
    for (const browser of browsers) {
      console.log(`${browser.name}: ${browser.installed ? browser.executablePath : "not installed"}`);
    }
  }
  if (args.check) process.exit(browsers.some((browser) => browser.installed) ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
