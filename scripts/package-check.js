#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRANULAR_OPERATION_COUNT, GRANULAR_OPERATION_NAMES, createBrowserOperations } from "../src/browser/operations/index.js";
import { createBrowserAgent } from "../src/adapters/sdk/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "dist/core/index.js",
  "dist/adapters/mcp/server.js",
  "dist/adapters/opencode/index.js",
  "dist/adapters/sdk/index.js",
  "dist/cli/index.js",
  "extension/manifest.json",
  "native-host/src/host.js",
  "skills/opencode-browser-plugin/SKILL.md",
  "skills/opencode-browser-plugin/agents/openai.yaml",
];
for (const relative of required) if (!fs.existsSync(path.join(root, relative))) throw new Error(`Build/package file is missing: ${relative}`);

const agent = createBrowserAgent();
try {
  const tools = agent.tools("mcp");
  if (tools.length !== 4) throw new Error(`Expected four core tools, found ${tools.length}`);
  const hooks = await createBrowserOperations();
  const names = Object.keys(hooks.tool ?? {});
  if (names.length !== GRANULAR_OPERATION_COUNT || names.join("\n") !== GRANULAR_OPERATION_NAMES.join("\n")) {
    throw new Error(`Granular operation inventory mismatch: expected ${GRANULAR_OPERATION_COUNT}, found ${names.length}`);
  }
  console.log(JSON.stringify({ ok: true, coreTools: tools.map((tool) => tool.name), granularOperations: names.length }, null, 2));
} finally {
  agent.close();
}
