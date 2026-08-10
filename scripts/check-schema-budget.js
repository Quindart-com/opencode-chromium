#!/usr/bin/env node

import { createBrowserAgent } from "../src/core/index.js";

const MAX_SCHEMA_BYTES = 10000;
const agent = createBrowserAgent();
try {
  const sizes = {};
  for (const dialect of ["mcp", "openai", "anthropic", "gemini"]) {
    const bytes = Buffer.byteLength(JSON.stringify(agent.tools(dialect)), "utf8");
    if (bytes > MAX_SCHEMA_BYTES) throw new Error(`${dialect} tool definitions use ${bytes} bytes; budget is ${MAX_SCHEMA_BYTES}`);
    sizes[dialect] = bytes;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, maxBytes: MAX_SCHEMA_BYTES, sizes }, null, 2)}\n`);
} finally {
  agent.close();
}
