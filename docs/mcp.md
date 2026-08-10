# MCP integration

The canonical MCP server is `opencode-browser-plugin` at `src/adapters/mcp/server.js`.

```powershell
bun run mcp
bun run mcp:http
```

Options:

```text
--transport=stdio|http
--toolset=core|debug|legacy
--host=127.0.0.1
--port=3210
--auth-token-env=AGENT_BROWSER_AUTH_TOKEN
```

Core mode exposes exactly `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Debug mode adds diagnostics; legacy mode exposes the preserved 49 granular operations for migration and regression testing only.

Cloud or remote MCP clients use the same core contract. For tab-level network debugging, call `browser_observe` with `mode: "capabilities"` and `pack: "network"`, then execute the returned `network.inspect` capability through `browser_run`; it is intentionally not registered as a fifth MCP tool.

stdio reserves stdout for MCP JSON-RPC. HTTP is loopback-only by default and refuses non-loopback binding without a bearer token. `/healthz` reports the contract version and server health; `/mcp` serves Streamable HTTP.

Artifacts are registered as resources using `browser://sessions/{sessionId}/artifacts/{artifactId}`. Screenshots and oversized values are not injected into the ordinary model context.

## Codex configuration

```toml
[mcp_servers.opencode-browser-plugin]
command = "bun"
args = ["C:\\absolute\\path\\to\\dist\\adapters\\mcp\\server.js"]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled_tools = ["browser_run", "browser_observe", "browser_session", "browser_finalize"]
default_tools_approval_mode = "writes"
```
