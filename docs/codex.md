# Codex

Register `dist/adapters/mcp/server.js` as the required local MCP server named `opencode-browser-plugin`:

```powershell
codex mcp add opencode-browser-plugin -- bun C:\absolute\path\to\dist\adapters\mcp\server.js
codex mcp list
```

The Codex skill is `skills/opencode-browser-plugin/SKILL.md`. It tells the agent to reuse sessions, batch actions, pass a selected profile early, request capabilities only when needed, use approval tokens exactly once, retrieve artifacts, and finalize owned tabs.
