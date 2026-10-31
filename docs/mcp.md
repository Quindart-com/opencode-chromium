# MCP integration

The canonical MCP server is `opencode-browser-plugin` at `src/adapters/mcp/server.ts`.

```powershell
bun src/adapters/mcp/server.ts
bun run mcp:http
```

Options:

```text
--transport=stdio|http
--host=127.0.0.1
--port=3210
--auth-token-env=AGENT_BROWSER_AUTH_TOKEN
--allowed-origin=PATTERN
--blocked-origin=PATTERN
```

The public surface is exactly `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Internal operations remain implementation details behind those four tools.

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

Use `frames.list`, then pass a returned ID as `target.frameId` to search, inspect, extract, focus, click, press, fill, assert, settle, or upload inside that frame. The default stays the top document; searches do not automatically combine every frame. Search results carry frame identity, and node handles retain their frame and document identity. Rediscover after frame navigation or replacement. Both same-origin and cross-origin frames follow the existing origin policy and tab ownership checks.

Coordinates with a frame target are CSS viewport coordinates within that frame. Trusted input and the visible cursor are translated through its ancestors. An unresolved iframe coordinate target returns `FRAME_TARGET_REQUIRED`; a covered ancestor returns `FRAME_OBSTRUCTED`. Rotated or perspective-transformed frames return `UNSUPPORTED_FRAME` for coordinate input. Keep the embedded parent open when uploading. File selection (`set:true`) confirms the browser received files; verify the application's preview or crop state separately.

`focus` accepts focusable controls, including links, buttons, readonly inputs, selects and contenteditable regions. `press` with a target focuses it before dispatch; without a target it uses current focus. Enter retains its approval flow. Ordinary Chromium clicks preserve background page activation; controls requiring trusted pointer input can use `diagnostics.cdp` after inspecting a fresh screenshot. Convert image coordinates to CSS viewport coordinates using the returned capture geometry, send matched mouse press/release events, then verify the resulting UI and native-dialog events.

Observations include `observation.capturedAt`, `documentId`, `frameId`, revision and scope. DOM quiet means 500 ms without relevant changes, not proof that the application saved a value. Use an explicit `settle` condition for the expected outcome and reopen persisted settings when appropriate. Unsettled or uncertain mutations are excluded from successful memory recipes.

The extension's runtime connection is separate from tab health, returned with session tab listings. Check `browser_observe` mode `events` for `dialogs.open` when page commands stall. Event reads and `handleDialog` use a recovery path without attaching first; accepting a prompt still requires approval. Timeout details identify phase, method, tab and known dialog type. A timeout can occur after a mutation ran: inspect current state before repeating it. `browser_finalize` can return `status:"partial"` with per-tab results; handle the blocked dialog and finalize again using the same session.

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
