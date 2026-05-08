#!/usr/bin/env node
/* global console */
/* Detect whether Google Chrome is currently running. */

let path;
let process;
let execFileSync;
let readlinkSync;

const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};

const MACOS_CHROME_APP_PATH_FRAGMENT = "/Google Chrome.app/Contents/";
const MACOS_CHROME_SINGLETON_LOCK_PATH = [
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "SingletonLock",
];

async function loadNodeModules() {
  path = await import("node:path");
  process = (await import("node:process")).default;
  ({ execFileSync } = await import("node:child_process"));
  ({ readlinkSync } = await import("node:fs"));
}

function usage() {
  console.error("Usage: scripts/chrome-is-running.js [--check] [--json]");
}

function formatCommandError(command, args, error) {
  const commandDisplay = [command, ...args].join(" ");
  const details = [
    error?.code,
    typeof error?.status === "number" ? `exit ${error.status}` : null,
    error?.stderr?.toString().trim(),
    error?.message,
  ].filter(Boolean);
  return `Failed to run ${commandDisplay}: ${details.join("; ")}`;
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(formatCommandError(command, args, error), { cause: error });
  }
}

function stripCommandArguments(command) {
  return command.trim().replace(/\s--.*$/, "");
}

function chromeProcessNameForCommand(command) {
  const executable = stripCommandArguments(command);
  const processName = path.basename(executable);

  if (process.platform === "darwin") {
    if (!executable.includes(MACOS_CHROME_APP_PATH_FRAGMENT))
      return processName;

    if (
      processName === "Google Chrome" ||
      processName.startsWith("Google Chrome Helper")
    )
      return processName;
  }

  return processName;
}

function parseProcessList(output, processNames) {
  if (!output) return [];

  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;

    const [, pid, command] = match;
    const processName = chromeProcessNameForCommand(command);
    if (!processNames.has(processName)) continue;

    processes.push({
      pid: Number(pid),
      process_name: processName,
      command: stripCommandArguments(command),
    });
  }

  return processes;
}

function parseMacosApplicationProcessList(output) {
  const processes = parseProcessList(
    output,
    CHROME_PROCESS_NAMES_BY_PLATFORM.darwin,
  );

  return processes.filter((chromeProcess) => {
    return chromeProcess.command.includes(MACOS_CHROME_APP_PATH_FRAGMENT);
  });
}

function parseWindowsTaskList(output) {
  if (!output) return [];

  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)",/);
    if (!match || match[1].toLowerCase() !== "chrome.exe") continue;

    processes.push({
      pid: Number(match[2]),
      process_name: match[1],
      command: match[1],
    });
  }

  return processes;
}

function getMacosChromeSingletonProcess() {
  if (!process.env.HOME) return null;

  let singletonLockTarget;
  try {
    singletonLockTarget = readlinkSync(
      path.join(process.env.HOME, ...MACOS_CHROME_SINGLETON_LOCK_PATH),
      "utf8",
    );
  } catch {
    return null;
  }

  const pidMatch = singletonLockTarget.match(/-(\d+)$/);
  if (!pidMatch) return null;

  const pid = Number(pidMatch[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return null;
  }

  return {
    pid,
    process_name: "Google Chrome",
    command: "Google Chrome",
  };
}

function findRunningChromeProcesses() {
  const processNames =
    CHROME_PROCESS_NAMES_BY_PLATFORM[process.platform] || new Set(["chrome"]);

  if (process.platform === "win32") {
    return parseWindowsTaskList(
      runCommand("tasklist", [
        "/fo",
        "csv",
        "/nh",
        "/fi",
        "imagename eq chrome.exe",
      ]),
    );
  }

  const singletonProcess =
    process.platform === "darwin" ? getMacosChromeSingletonProcess() : null;

  let processList;
  try {
    processList = runCommand("ps", ["-A", "-o", "pid=", "-o", "comm="]);
  } catch (error) {
    if (singletonProcess != null) return [singletonProcess];

    throw error;
  }

  const processes = parseProcessList(processList, processNames);
  if (processes.length > 0 || process.platform !== "darwin") return processes;

  try {
    return parseMacosApplicationProcessList(
      runCommand("ps", ["-A", "-ww", "-o", "pid=", "-o", "command="]),
    );
  } catch (error) {
    if (singletonProcess != null) return [singletonProcess];

    throw error;
  }
}

function parseArgs(argv) {
  const flags = new Set(argv);
  if (flags.has("-h") || flags.has("--help")) {
    usage();
    process.exit(0);
  }

  const supportedFlags = new Set(["--check", "--json"]);
  const unsupportedFlags = argv.filter((arg) => !supportedFlags.has(arg));
  if (unsupportedFlags.length > 0) {
    usage();
    process.exit(2);
  }

  return {
    check: flags.has("--check"),
    json: flags.has("--json"),
  };
}

function printTextReport(result, check) {
  if (check) {
    console.log("Google Chrome running check");
    console.log(`status: ${result.running ? "ok" : "not running"}`);
    console.log("");
  }

  console.log(`Google Chrome running: ${result.running ? "yes" : "no"}`);
  if (result.processes.length === 0) return;

  console.log("Processes:");
  for (const chromeProcess of result.processes) {
    console.log(`  - pid: ${chromeProcess.pid}`);
    console.log(`    process: ${chromeProcess.process_name}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const processes = findRunningChromeProcesses();
  const result = {
    platform: process.platform,
    running: processes.length > 0,
    processes,
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printTextReport(result, args.check);

  if (args.check && !result.running) process.exitCode = 1;
}

void loadNodeModules()
  .then(() => {
    main();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    (process || globalThis.process)?.exit(2);
  });
