# OpenCode Browser Adapter MCP server

This is the provider-neutral MCP entrypoint used by Codex and any MCP-capable agent client. It uses the official TypeScript MCP SDK and exposes four AI-first tools by default:

- `browser_run` — execute up to 20 actions with conditional settle and `postObserve`.
- `browser_observe` — compact lexical/adaptive search, inspection, events, or screenshots.
- `browser_session` — open a named profile with tabs, or create, claim, release, and name tabs.
- `browser_finalize` — close or hand off session tabs.

The existing 49 granular tools remain available during migration with `--toolset=legacy`. `--toolset=debug` exposes both surfaces and should not be used as an everyday agent configuration because it consumes much more model context.

The bundled Codex skill is at `codex-adapter/skill/opencode-browser-adapter/SKILL.md`. It enforces connector-first routing, single-call action/settle/verification chains, and longer initial yields for intentionally deep searches instead of wrapper wait loops.

## Codex configuration

Add this server to `~/.codex/config.toml`:

```toml
[mcp_servers.opencode-browser-adapter]
command = "node"
args = ["C:\\path\\to\\Opencode-Plugins\\codex-adapter\\mcp-server.js"]
```

The default transport is stdio. Restart Codex after changing its MCP configuration.

For a temporary compatibility window:

```toml
[mcp_servers.opencode-browser-adapter-legacy]
command = "node"
args = ["C:\\path\\to\\Opencode-Plugins\\codex-adapter\\mcp-server.js", "--toolset=legacy"]
```

Do not enable both servers for normal work; that defeats the context reduction.

## Streamable HTTP

```bash
npm run agent:http
# http://127.0.0.1:3210/mcp
```

Loopback HTTP validates `Host` and `Origin`. A non-loopback bind is refused unless the environment variable named by `--auth-token-env` exists; the default is `AGENT_BROWSER_AUTH_TOKEN`, supplied by clients as a bearer token.

```bash
node codex-adapter/mcp-server.js --transport=http --host=0.0.0.0 --port=3210
```

## Session and artifact behavior

The first tool result returns a `sessionId`; reuse it across calls when the client does not keep one MCP process per task. Screenshots and oversized JSON default to ephemeral `browser://sessions/.../artifacts/...` resources instead of entering model context as base64 or large dumps. Artifacts expire after 30 minutes by default.

## Validation

```bash
npm run check:codex-adapter
```

This verifies the official stdio handshake, the four-tool default, the 49-tool compatibility mode, and the core schema budget.
