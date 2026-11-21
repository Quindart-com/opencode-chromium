# OpenCode V2

The package root is the native OpenCode entry point. It default-exports the official OpenCode 1.18.x path-plugin module shape (`{ id, server() }`), exposes four direct tools from `server()`, and also exports the V2 `setup` descriptor. The V2 registration path sets `codemode: false` and returns cleanup for repeated activation and reload.

Install the package once (`npm install -g opencode-chromium`) and reference it by name from the global `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chromium"]
}
```

Pin a version with the npm spec (`"opencode-chromium@1.6.3"`) if you prefer locked upgrades. For a local build, use:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/dist/adapters/opencode/index.js"]
}
```

The native adapter accepts a V2 context with `tools.add`, `tool.add`, `addTool`, or `tool.transform`. It also exposes the same tool definitions to test harnesses through the cleanup function returned by `setup`.

The default export is dual-shaped, `{ id, server, setup }`: OpenCode 1.18/1.19 loads `server`, while OpenCode 2.x loads `setup` and registers all tools through a single `tool.transform` (disposed on cleanup). Both `opencode-chromium setup` and `opencode-chromium link` detect the installed OpenCode version; for 2.x they write the `plugins` key pointing at the launcher's `v2` directory, whose `index.ts` re-exports the launcher default.

Use MCP separately for compatibility mode; enabling both surfaces simultaneously creates duplicate tools and is reported by `doctor`.
