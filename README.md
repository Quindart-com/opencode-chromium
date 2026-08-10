<p align="center"><img src="assets/logo.svg" alt="OpenCode Browser Plugin Logo" width="200"/></p>

<h1 align="center">opencode-browser-plugin</h1>

<p align="center"><strong>Provider-neutral Chromium automation for MCP clients, OpenCode V2, Codex, and direct JavaScript agents.</strong></p>

## What it provides

- Four compact default tools: `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`.
- The complete multi-operation browser engine behind explicit compatibility and capability modes.
- Context-lean evidence: observation summaries omit empty fields, duplicate text, and verbose `html`/`styles` (available only through `detail: "debug"`), and inline responses stay within the 4,096-character budget with oversized output spilled to artifact resources.
- Native hover, JavaScript dialog handling with approval gating, and png/jpeg/webp screenshots with quality control.
- Non-intrusive background automation: clicks, typing, and navigation never activate the tab or bring its window forward, so you can keep working while the tool drives a background tab.
- Server-level origin policy (allowed/blocked origin globs) and file-root restrictions for uploads.
- Persistent session emulation (viewport, network, CPU, geolocation, color scheme, user agent, headers, init scripts) with automatic reset on finalize.
- Network request drill-down by requestId with artifact-backed body spillover, and source-mapped console stack traces.
- Performance diagnostics: `browser_observe` mode `diagnostic` records CDP traces and computes LCP, CLS, long tasks, TBT, and more in the native host; raw traces are artifact-first and CrUX/field data stays off.
- Snowflake-default page search with explicit lexical/auto alternatives and Qwen deep retrieval without loading models in the extension.
- Profile-aware sessions, tab ownership, stale-target recovery, bounded read retries, conditional settling, approvals, and artifact resources.
- MCP stdio and loopback/ authenticated HTTP transports with protocol-clean stdout.
- A native OpenCode V2 adapter and shared OpenAI, Anthropic, Gemini, and MCP schema adapters.

## Requirements

- Node.js 20 or newer.
- Bun 1.1 or newer (the supported package manager and command runner).
- A Chromium-family browser with the unpacked `extension/` loaded.
- The native messaging host installed for the extension ID.

## Install and build

```powershell
bun install --frozen-lockfile
bun run build
bun test
bun run check
```

The package is released as `1.5.0` under the canonical name `opencode-browser-plugin`.

## MCP

Run the four-tool server over stdio:

```powershell
bun run mcp
```

Or use the packaged binary:

```powershell
opencode-browser-plugin-mcp
```

Loopback Streamable HTTP is available with:

```powershell
bun run mcp:http
```

Non-loopback HTTP requires a bearer token in `AGENT_BROWSER_AUTH_TOKEN` (or the variable selected with `--auth-token-env`). The default server name is `opencode-browser-plugin`. Origin and file-root safety configuration is server-level: pass `--allowed-origin` / `--blocked-origin` globs, or set `AGENT_BROWSER_ALLOWED_ORIGINS`, `AGENT_BROWSER_BLOCKED_ORIGINS`, and `AGENT_BROWSER_ALLOWED_FILE_ROOTS` (see [docs/mcp.md](docs/mcp.md)).

## OpenCode V2

The package root exports the native adapter using OpenCode 1.18.x's official `{ id, server() }` path-plugin module shape, alongside the V2 setup contract:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-browser-plugin"]
}
```

For a local build, point the client at `dist/adapters/opencode/index.js`. The adapter registers exactly four tools, sets `codemode: false`, and returns a cleanup function for reloads.

The same browser runtime is available through MCP compatibility mode; do not enable both surfaces in one client session unless duplicate tools are intentional.

## Codex

Register the local MCP server with Bun:

```powershell
codex mcp add opencode-browser-plugin -- bun C:\absolute\path\to\dist\adapters\mcp\server.js
```

The bundled skill is [skills/opencode-browser-plugin/SKILL.md](skills/opencode-browser-plugin/SKILL.md). It follows the open [Agent Skills](https://agentskills.io) standard and covers connector-first routing, profile selection, action batching, Snowflake-default search, approval tokens, artifacts, and finalization. It ships with [agents/openai.yaml](skills/opencode-browser-plugin/agents/openai.yaml) for the ChatGPT/Codex desktop Skills picker and MCP dependency metadata.

Install it for every skills-compatible client at once:

```powershell
opencode-browser-plugin install --client skills
opencode-browser-plugin install --client skills --dry-run
opencode-browser-plugin uninstall --client skills
```

This copies the skill to `~/.codex/skills/`, `~/.claude/skills/`, and `~/.agents/skills/` (under `opencode-browser-plugin/`), and registers an enabled `[[skills.config]]` entry in `~/.codex/config.toml` while removing any stale `opencode-browser-adapter` entry.

## Native host and extension

Load `extension/` as an unpacked extension, then install the host:

```powershell
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
bun run check:native-host -- --json
```

Use `AGENT_BROWSER_*` environment variables for new configuration. The older `OPENCODE_BROWSER_*` names remain lower-priority aliases through the 1.x compatibility window.

## CLI

```powershell
opencode-browser-plugin doctor --json
opencode-browser-plugin verify
opencode-browser-plugin install --client opencode --dry-run
opencode-browser-plugin install --client opencode-mcp --dry-run
opencode-browser-plugin install --client codex --dry-run
opencode-browser-plugin install --client skills --dry-run
opencode-browser-plugin uninstall --client codex --dry-run
opencode-browser-plugin uninstall --client skills --dry-run
```

Install and uninstall back up the named configuration before changing it, touch only the canonical entry, support dry runs, and report changed files.

## Context and capabilities

The default tool schemas stay small. Request advanced descriptions through:

```json
{"mode":"capabilities","pack":"downloads"}
```

Execute advanced work through `browser_run` without adding top-level tools:

```json
{
  "steps": [{
    "action": "capability",
    "capability": "downloads.events",
    "input": {}
  }]
}
```

For deep request/response debugging, request the lazy network pack only when needed:

```json
{"mode":"capabilities","pack":"network"}
```

Then execute `network.inspect` in `browser_run` with the target `tabId`. It follows the tab's CDP request/response lifecycle, supports URL/method/type/status/requestId filters, and returns redacted headers only when `includeHeaders` is requested. Bodies remain disabled unless explicitly requested and approved; `bodyDelivery: "artifact"` spills opted-in bodies to the artifact store instead of inline previews. `browser_observe` mode `inspect` with `target.requestId` returns a single request's lifecycle detail.

Large results and screenshots are artifact-first. MCP clients retrieve them through `browser://sessions/<session-id>/artifacts/<artifact-id>`; OpenCode can request the same URI with `browser_observe` mode `artifact`.

## Repository layout

```text
src/core/                 shared runtime, schemas, safety, artifacts, versions
src/browser/              profile-aware IPC client, policies, and operation engine
src/adapters/mcp/         universal MCP server and transports
src/adapters/opencode/    native OpenCode V2 adapter
src/adapters/sdk/         provider schema adapters and direct agent API
src/cli/                  install, configure, uninstall, doctor, verify
extension/                Manifest V3 browser integration
native-host/              native messaging host and semantic workers
skills/                   provider-neutral browser skill
tests/                    unit, contract, browser, and adapter regression tests
docs/                     architecture, compatibility, security, and migration guides
```

## Verification and release

```powershell
bun run build
bun run check:schemas
bun run check:package
bun run check:mcp
bun run test:contracts
bun run test:opencode
bun run pack
bun run test:tarball
bun run check:release
```

The release check rejects stale V1 paths, personal state, duplicate legacy package surfaces, schema growth beyond budget, and tarballs missing the built adapters.

## Security

Browser content is untrusted. Consequential actions require short-lived immutable approval tokens; writes are never automatically repeated after uncertain execution. Artifacts are session scoped, expire, reject traversal, and are not written to logs. MCP protocol data stays on stdout and diagnostics stay on stderr.

See [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/compatibility.md](docs/compatibility.md), and [docs/migration-1.0.md](docs/migration-1.0.md).

## License

MIT
