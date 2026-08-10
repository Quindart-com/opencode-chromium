#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserAgent } from "../src/adapters/sdk/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dialects = ["mcp", "openai", "anthropic", "gemini"];

export function createParityReport() {
  const agent = createBrowserAgent();
  try {
    const tools = Object.fromEntries(dialects.map((dialect) => [dialect, agent.tools(dialect)]));
    const names = tools.mcp.map((tool) => tool.name);
    return {
      generatedAt: new Date().toISOString(),
      package: "opencode-browser-plugin",
      canonicalTools: names,
      adapters: Object.fromEntries(dialects.map((dialect) => [dialect, {
        names: tools[dialect].map((tool) => tool.name),
        schemaBytes: Buffer.byteLength(JSON.stringify(tools[dialect]), "utf8"),
        descriptionsMatch: tools[dialect].every((tool, index) => tool.description === tools.mcp[index]?.description),
        annotationsCompatible: dialect === "mcp" || tools[dialect].length === tools.mcp.length,
        annotationTransport: dialect === "mcp" ? "native" : "provider-syntax",
      }])),
    };
  } finally {
    agent.close();
  }
}

if (process.argv[1]?.endsWith("parity-report.js")) {
  const report = createParityReport();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "adapter-parity.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
