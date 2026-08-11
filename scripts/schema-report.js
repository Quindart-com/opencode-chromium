#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBrowserAgent } from "../src/adapters/sdk/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const reportDir = path.join(root, "reports");
fs.mkdirSync(reportDir, { recursive: true });
const agent = createBrowserAgent();
try {
  const report = { generatedAt: new Date().toISOString(), package: packageJson.name, version: packageJson.version, schemas: {} };
  for (const dialect of ["mcp", "openai", "anthropic", "gemini"]) {
    const json = JSON.stringify(agent.tools(dialect));
    report.schemas[dialect] = { bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex") };
  }
  fs.writeFileSync(path.join(reportDir, "schema-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  agent.close();
}
