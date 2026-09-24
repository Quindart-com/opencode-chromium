#!/usr/bin/env node
// Register the native messaging host with the installed browsers. The
// implementation lives in src/cli/native-host.js so the CLI can reuse it; this
// stays as the documented `bun run install:native-host` entry point.

import { installManifest, parseArgs } from "../src/cli/native-host.js";

try {
  const result = installManifest(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  // A skipped browser means the tools will not work there, so fail loudly
  // instead of reporting success for a no-op.
  if (result.skipped.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error("Usage: node scripts/install-native-host.js [--auto] [--extension-id <id> ...] [--browsers chrome,edge,brave,chromium|all] [--host-path <executable>]");
  process.exit(1);
}
