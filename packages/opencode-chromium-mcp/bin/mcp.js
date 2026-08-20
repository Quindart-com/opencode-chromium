#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entry = require.resolve("opencode-chromium/mcp");
const { status } = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 0);