#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_NAME = "opencode-browser-adapter";
const OUTDATED_PLUGIN_FILE = "chromium-browser.js";
const OUTDATED_SKILL_DIR = "chromium-browser";

function usage() {
  console.error("Usage: node scripts/install-opencode.js [--remove] [--config-dir <dir>]");
  console.error("");
  console.error("Registers the OpenCode Browser Adapter plugin and skill globally for OpenCode.");
  console.error("The global plugin file re-exports this repository's entrypoint, so repository");
  console.error("changes apply immediately without reinstalling.");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--remove") {
      args.remove = true;
      continue;
    }
    if (arg === "--config-dir") {
      args.configDir = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function configDir(override) {
  if (override) return path.resolve(override);
  if (process.env.OPENCODE_CONFIG_DIR) return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  return path.join(os.homedir(), ".config", "opencode");
}

function removeIfExists(target, removed) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

function removeOutdated(config, removed) {
  removeIfExists(path.join(config, "plugins", OUTDATED_PLUGIN_FILE), removed);
  removeIfExists(path.join(config, "skills", OUTDATED_SKILL_DIR), removed);
}

function writeGlobalPlugin(config, root) {
  const entry = path.join(root, ".opencode", "plugins", `${PLUGIN_NAME}.js`);
  if (!fs.existsSync(entry)) throw new Error(`Repository entrypoint not found: ${entry}`);
  const pluginsDir = path.join(config, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const target = path.join(pluginsDir, `${PLUGIN_NAME}.js`);
  const body = `export { OpencodeBrowserAdapter } from ${JSON.stringify(pathToFileURL(entry).href)};\n`;
  fs.writeFileSync(target, body, "utf8");
  return target;
}

function syncSkill(config, root) {
  const source = path.join(root, ".opencode", "skills", PLUGIN_NAME);
  if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error(`Repository skill not found: ${source}`);
  const target = path.join(config, "skills", PLUGIN_NAME);
  fs.cpSync(source, target, { recursive: true });
  return target;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const config = configDir(args.configDir);
  const removed = [];

  removeOutdated(config, removed);

  if (args.remove) {
    removeIfExists(path.join(config, "plugins", `${PLUGIN_NAME}.js`), removed);
    removeIfExists(path.join(config, "skills", PLUGIN_NAME), removed);
    console.log(JSON.stringify({ ok: true, removed }, null, 2));
    process.exit(0);
  }

  const pluginPath = writeGlobalPlugin(config, root);
  const skillPath = syncSkill(config, root);
  console.log(JSON.stringify({ ok: true, config, pluginPath, skillPath, removed }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
