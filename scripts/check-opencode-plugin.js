#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function configDir(root) {
  const preferred = path.join(root, ".opencode");
  if (fs.existsSync(preferred)) return preferred;
  return path.join(root, ".oopencode");
}

async function loadPluginModule(root) {
  const pluginPath = path.join(configDir(root), "plugins", "chromium-browser.js");
  if (!fs.existsSync(pluginPath)) throw new Error(`Plugin entrypoint not found: ${pluginPath}`);
  return import(pathToFileURL(pluginPath).href);
}

function assertToolDefinition(exportName, toolName, definition) {
  if (!definition || typeof definition !== "object") throw new Error(`${exportName}.${toolName} is not a tool object`);
  if (typeof definition.description !== "string" || definition.description.length === 0) {
    throw new Error(`${exportName}.${toolName} is missing description`);
  }
  if (!definition.args || typeof definition.args !== "object") throw new Error(`${exportName}.${toolName} is missing args`);
  if (typeof definition.execute !== "function") throw new Error(`${exportName}.${toolName} is missing execute`);
  z.toJSONSchema(z.object(definition.args));
}

try {
  const root = repoRoot();
  const mod = await loadPluginModule(root);
  const summaries = [];

  for (const [exportName, plugin] of Object.entries(mod)) {
    if (typeof plugin !== "function") continue;
    const hooks = await plugin({ directory: root, worktree: root });
    const tools = hooks?.tool ?? {};
    for (const [toolName, definition] of Object.entries(tools)) {
      assertToolDefinition(exportName, toolName, definition);
    }
    summaries.push({ exportName, tools: Object.keys(tools).length });
  }

  if (summaries.length === 0) throw new Error("Plugin module does not export a plugin function");
  console.log(JSON.stringify({ ok: true, plugins: summaries }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
