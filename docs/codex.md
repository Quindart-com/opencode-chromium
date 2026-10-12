# Codex

## Native plugin

Install the plugin from this repository's marketplace:

```sh
codex plugin marketplace add Quindart-com/opencode-chromium --ref master
codex plugin add opencode-browser-plugin@quindart-browser
```

The native manifest at `.codex-plugin/plugin.json` bundles the browser skill
and `.mcp.json`. The MCP configuration runs the published `opencode-chromium`
runtime through `npx`; Node.js 20 or later is required. Install the browser
extension and register its native host with `npx -y opencode-chromium@latest setup`
before controlling a browser. See [Firefox setup](firefox.md) for Firefox profiles.

If you already registered the same MCP server manually, remove that registration
with `codex mcp remove opencode-browser-plugin` before enabling the native plugin
to avoid duplicate tools. Choose either native plugin installation or manual MCP
registration below.

## Manual MCP registration

Register the required MCP server named `opencode-browser-plugin` from the npm package:

```powershell
codex mcp add opencode-browser-plugin -- npx -y opencode-chromium-mcp
codex mcp list
```

`opencode-chromium-mcp` is published on npm as a standalone launcher for the
MCP server shipped inside `opencode-chromium`, so `npx` resolves it directly.

From a local checkout, register `dist/adapters/mcp/server.js` with Bun instead:

```powershell
codex mcp add opencode-browser-plugin -- bun C:\absolute\path\to\dist\adapters\mcp\server.js
```

The Codex skill is `skills/opencode-browser-plugin/SKILL.md`. It tells the agent to reuse sessions, batch actions, pass a selected profile early, request capabilities only when needed, use approval tokens exactly once, retrieve artifacts, and finalize owned tabs.
