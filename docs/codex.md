# Codex

Register the required MCP server named `opencode-browser-plugin` from the npm package:

```powershell
codex mcp add opencode-browser-plugin -- npx -y opencode-chromium-mcp
codex mcp list
```

From a local checkout, register `dist/adapters/mcp/server.js` with Bun instead:

```powershell
codex mcp add opencode-browser-plugin -- bun C:\absolute\path\to\dist\adapters\mcp\server.js
```

The Codex skill is `skills/opencode-browser-plugin/SKILL.md`. It tells the agent to reuse sessions, batch actions, pass a selected profile early, request capabilities only when needed, use approval tokens exactly once, retrieve artifacts, and finalize owned tabs.
