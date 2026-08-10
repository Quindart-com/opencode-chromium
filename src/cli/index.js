#!/usr/bin/env node

import process from "node:process";
import { main as mcpMain } from "../adapters/mcp/server.js";
import { configureClient } from "./configure.js";
import { runDoctor } from "./doctor.js";
import { installClient } from "./install.js";
import { uninstallClient } from "./uninstall.js";
import { verify } from "./verify.js";
import { packageInfo } from "./version.js";

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function has(argv, flag) {
  return argv.includes(flag);
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "doctor", ...rest] = argv;
  if (command === "mcp") return mcpMain(rest);
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(JSON.stringify(packageInfo(), null, 2));
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor({ json: has(rest, "--json") });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await verify(), null, 2));
    return;
  }
  if (["install", "configure", "uninstall"].includes(command)) {
    const client = valueAfter(rest, "--client");
    if (!client) throw new Error(`${command} requires --client opencode|opencode-mcp|codex|skills`);
    const options = { client, config: valueAfter(rest, "--config"), dryRun: has(rest, "--dry-run"), serverPath: valueAfter(rest, "--server") };
    const result = command === "install" ? installClient(options) : command === "configure" ? configureClient(options) : uninstallClient(options);
    const { before: _before, after: _after, ...publicResult } = result;
    const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles : result.changed ? [result.filePath] : [];
    console.log(JSON.stringify({ ok: true, ...publicResult, changedFiles }, null, 2));
    return;
  }
  if (command === "help" || command === "--help") {
    console.log("Usage: opencode-browser-plugin <install|configure|uninstall|doctor|verify|mcp|version>");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1]?.endsWith("src\\cli\\index.js") || process.argv[1]?.endsWith("src/cli/index.js") || process.argv[1]?.endsWith("dist\\cli\\index.js") || process.argv[1]?.endsWith("dist/cli/index.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
