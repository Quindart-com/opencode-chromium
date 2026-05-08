#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

const PROCESS_NAMES = {
  chrome: ["chrome.exe", "Google Chrome", "Google Chrome Helper", "chrome", "google-chrome"],
  edge: ["msedge.exe", "Microsoft Edge", "Microsoft Edge Helper", "msedge"],
  brave: ["brave.exe", "Brave Browser", "Brave Browser Helper", "brave", "brave-browser"],
  chromium: ["chromium.exe", "Chromium", "Chromium Helper", "chromium", "chromium-browser"],
};

function usage() {
  console.error("Usage: node scripts/chrome-is-running.js [--browser chrome|edge|brave|chromium] [--check] [--json]");
}

function parseArgs(argv) {
  const args = { browser: "chrome", json: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--browser") args.browser = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!PROCESS_NAMES[args.browser]) throw new Error(`Unsupported browser: ${args.browser}`);
  return args;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function windowsProcesses(browser) {
  const names = new Set(PROCESS_NAMES[browser].map((name) => name.toLowerCase()));
  const output = run("tasklist", ["/fo", "csv", "/nh"]);
  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)",/);
    if (!match || !names.has(match[1].toLowerCase())) continue;
    processes.push({ pid: Number(match[2]), processName: match[1] });
  }
  return processes;
}

function unixProcesses(browser) {
  const names = PROCESS_NAMES[browser].map((name) => name.toLowerCase());
  const output = run("ps", ["-axo", "pid=,comm="]);
  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2].toLowerCase();
    if (!names.some((name) => command.includes(name.toLowerCase()))) continue;
    processes.push({ pid: Number(match[1]), processName: match[2] });
  }
  return processes;
}

function getStatus(browser) {
  const processes = process.platform === "win32" ? windowsProcesses(browser) : unixProcesses(browser);
  return { browser, running: processes.length > 0, processes };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const status = getStatus(args.browser);
  if (args.json) console.log(JSON.stringify(status, null, 2));
  else console.log(status.running ? `${args.browser} is running` : `${args.browser} is not running`);
  if (args.check) process.exit(status.running ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
