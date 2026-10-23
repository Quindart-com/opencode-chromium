#!/usr/bin/env node

import fs from "node:fs";
import { configPath } from "../src/cli/config.ts";
import { createBrowserAgent } from "../src/adapters/sdk/index.ts";
import { packageInfo } from "../src/cli/version.ts";

export function localClientReport() {
  const agent = createBrowserAgent();
  try {
    return {
      ...packageInfo(),
      tools: agent.tools("mcp").map((tool) => tool.name),
      clients: Object.fromEntries(["opencode", "opencode-mcp", "codex"].map((client) => {
        const filePath = configPath(client);
        return [client, { filePath, exists: fs.existsSync(filePath) }];
      })),
    };
  } finally {
    agent.close();
  }
}

if (process.argv[1]?.endsWith("local-client-report.js")) {
  console.log(JSON.stringify(localClientReport(), null, 2));
}
