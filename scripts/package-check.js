#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRANULAR_OPERATION_COUNT, GRANULAR_OPERATION_NAMES, createBrowserOperations } from "../src/browser/operations/index.js";
import { createBrowserAgent } from "../src/adapters/sdk/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const metadataErrors = [];
if (packageJson.name !== "opencode-chromium") metadataErrors.push(`Unexpected package name: ${packageJson.name}`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version ?? "")) metadataErrors.push(`Invalid package version: ${packageJson.version}`);
if (packageJson.repository?.url !== "git+https://github.com/Quindart-com/opencode-chromium-browser-plugin.git") metadataErrors.push("Repository metadata must point to the canonical GitHub repository");
if (packageJson.publishConfig?.access !== "public") metadataErrors.push("Package must be configured for public npm access");
if (packageJson.publishConfig?.registry !== "https://registry.npmjs.org") metadataErrors.push("Package must publish to the public npm registry");
if (packageJson.bin?.["opencode-chromium"] !== "./dist/cli/index.js") metadataErrors.push("Canonical CLI binary is missing");
if (packageJson.bin?.["opencode-chromium-mcp"] !== "./dist/adapters/mcp/server.js") metadataErrors.push("Canonical MCP binary is missing");
if (packageJson.bin?.["opencode-browser-plugin-mcp"] !== "./dist/adapters/mcp/server.js") metadataErrors.push("Legacy MCP binary alias is missing");
if (metadataErrors.length > 0) throw new Error(metadataErrors.join("\n"));
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
