#!/usr/bin/env node
export { formatRuntimeStatus } from "./status-format.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "help";
  if (["version", "--version", "-v"].includes(command)) {
    const { packageInfo } = await import("./version.ts");
    console.log(JSON.stringify(packageInfo(), null, 2));
    return;
  }
  if (["help", "--help"].includes(command)) {
    console.log("Usage: opencode-chromium <setup|manage|update|updates|harness|dev-extension|link|status|sync|install|configure|uninstall|doctor|verify|mcp|version>\n\nGet started: opencode-chromium setup --all\nChoose an app: opencode-chromium setup --targets codex\nPreview changes: opencode-chromium setup --all --dry-run --json\nConnection checks: opencode-chromium doctor\nReconnect browser tools: opencode-chromium harness reconnect <codex|opencode|dsh|claude-code|claude-desktop>\nInstall production updates: opencode-chromium updates install\nRefresh an unpacked build: opencode-chromium dev-extension --help\nMore setup options: opencode-chromium setup --help");
    return;
  }
  await (await import("./commands.ts")).dispatchCommand(argv);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("src/cli/index.ts") || process.argv[1]?.endsWith("src/cli/index.js") || process.argv[1]?.endsWith("dist\\cli\\index.js") || process.argv[1]?.endsWith("dist/cli/index.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
