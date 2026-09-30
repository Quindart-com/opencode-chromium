#!/usr/bin/env node
// List the Chromium-based browsers present on this machine. The inventory lives
// in src/cli/browsers.js so the CLI and this script cannot disagree.

import { describeInstalledBrowsers } from "../src/cli/browsers.js";

function usage() {
  console.error("Usage: node scripts/installed-browsers.js [--json] [--check]");
}

try {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }
  const unknown = args.filter((arg) => !["--json", "--check"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);

  const browsers = describeInstalledBrowsers();
  const result = { platform: process.platform, browsers };
  if (args.includes("--json") || args.includes("--check")) console.log(JSON.stringify(result, null, 2));
  else for (const browser of browsers) console.log(`${browser.name}: ${browser.installed ? browser.executablePath : "not installed"}`);
  if (args.includes("--check")) process.exit(browsers.some((browser) => browser.installed) ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
