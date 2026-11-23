# OpenCode

The package root is a native OpenCode plugin for both OpenCode 1.x and 2.x. Its default export, `{ id, server, setup }`, serves both versions:

| OpenCode | Loads | Config key |
| --- | --- | --- |
| 1.18, 1.19 | `server()`, which returns the four tools | `plugin` |
| 2.x | `setup`, which registers the four tools through one `tool.transform` and removes them on cleanup | `plugins` |

## Setup

```sh
npx -y opencode-chromium@latest setup --targets opencode
```

Setup and `opencode-chromium link` detect the installed OpenCode version and write the matching key. For 2.x, the entry points to the launcher's `v2` directory, whose `index.ts` re-exports the launcher's default export.

## Manual configuration

Install the package once (`npm install -g opencode-chromium`) and reference it from the global `~/.config/opencode/opencode.json`. For OpenCode 1.x:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chromium"]
}
```

For OpenCode 2.x, use the `plugins` key with the same value. Pin a version with an npm spec such as `"opencode-chromium@2.0.5"` if you prefer locked upgrades. For a local build, reference the compiled adapter:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/dist/adapters/opencode/index.js"]
}
```

The `setup` path sets `codemode: false` and returns cleanup for repeated activation and reload. It accepts a context that exposes `tools.add`, `tool.add`, `addTool` or `tool.transform`. The cleanup function also exposes the tool definitions to test harnesses.

Use MCP instead only when you need compatibility mode. Enabling both creates duplicate tools, and `doctor` reports it.
