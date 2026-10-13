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
--allowed-origin=PATTERN
--blocked-origin=PATTERN
```

Core mode exposes exactly `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Debug mode adds diagnostics; legacy mode exposes the preserved 55 granular operations for migration and regression testing only.

Origin policy is server-level and never per-call. `--allowed-origin` and `--blocked-origin` accept globs such as `https://*.example.com`; equivalent environment variables are `AGENT_BROWSER_ALLOWED_ORIGINS` and `AGENT_BROWSER_BLOCKED_ORIGINS` (comma- or semicolon-separated). Requested navigations and subsequent controlled-page URLs are checked. Redirect detection does not prevent the initial network request; see [policy limits](security.md). Uploads can be restricted with `AGENT_BROWSER_ALLOWED_FILE_ROOTS`.

Cloud or remote MCP clients use the same core contract. For tab-level network debugging, call `browser_observe` with `mode: "capabilities"` and `pack: "network"`, then execute the returned `network.inspect` capability through `browser_run`; it is intentionally not registered as a fifth MCP tool.

stdio reserves stdout for MCP JSON-RPC. HTTP is loopback-only by default and refuses non-loopback binding without a bearer token. `/healthz` reports the contract version and server health; `/mcp` serves Streamable HTTP.

Artifacts are registered as resources using `browser://sessions/{sessionId}/artifacts/{artifactId}`. Screenshots and oversized values are not injected into the ordinary model context.

## Optional capabilities

Discover a pack with `browser_observe` using `mode: "capabilities"` and the pack name. Execute a capability in `browser_run`: `{ "action": "capability", "capability": "visual.capture", "input": { "kind": "both" } }`. Pass the same profile, session and controlled tab throughout.

| Pack | Capabilities | Use |
| --- | --- | --- |
| `visual` | `visual.capture`, `visual.diff`, map and screenshot | Capture a `snapshot`, `pixels`, or `both` baseline. Pass the returned `baseline` URI to `visual.diff`; get added/removed/changed controls, changed-pixel ratio, bounds and a highlighted PNG artifact. |
| `advanced` | `frames.list`, `frames.inspect` | Discover up to 20 frames at depth 3 by default; explicit ceilings are 50 frames and depth 8. Inspect by returned `frameId`, with up to 2,000 characters by default. |
| `webmcp` | `webmcp.discover` | Discover experimental website tools, up to 20 entries by default (maximum 30). Schemas and descriptions are bounded. Discovery never executes a tool. Unavailable browsers return `supported: false`. |
| `network` | `network.inspect` | Inspect request lifecycle, timings, failures and redacted headers; request/response bodies need explicit approval. |
| `events` | `events.console`, `events.network` | Read bounded tab events; console inspection supports source maps on explicit request. |

Pixel comparisons use a per-channel tolerance (`threshold`, default 0.1), not perceptual similarity. Baselines belong to their original session, profile, tab and URL, expire with other artifacts, and require matching dimensions. Use a stable viewport or `clip` (maximum 1,600 × 1,200, two million pixels), settle the relevant state and avoid animations. Large or non-PNG captures fail explicitly. Changes outside the capture/visible control set are not measured.

Frame IDs are scoped to the controlled document. Rediscover after navigation; Firefox bridges its current BiDi contexts to document markers across reconnects. Discovery and inspection are bounded; this does not add automatic traversal to every locator or trusted action. Cross-origin frame inspection follows the same origin policy.

Name tab groups with `browser_session` action `open`, `name: "Checkout review"`, or action `name` to rename an existing session. Browsers without native groups keep the session label internally.

For Chromium performance traces, use `browser_observe` with `mode: "diagnostic"`, `diagnostic: { "type": "performance", "action": "record", "durationMs": 1000 }`. The trace stays in a local artifact and the result includes timing insights. Re-analyze with action `inspect` and `artifact` set to that URI. Firefox reports tracing as unsupported.

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
