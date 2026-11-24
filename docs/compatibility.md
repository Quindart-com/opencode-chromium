# Compatibility matrix

Every surface exposes the same four tools: `browser_run`, `browser_observe`, `browser_session` and `browser_finalize`. Version 2.0 removed the granular and legacy tool registrations.

## Agents and clients

| Surface | Transport | Status |
| --- | --- | --- |
| OpenCode 1.18 and 1.19 | Native plugin (`server()`) | Supported |
| OpenCode 2.x | Native plugin (`setup`) | Supported since 2.0.5 |
| OpenCode, any version | MCP stdio/HTTP | Supported (compatibility mode) |
| Codex CLI, IDE and desktop | Native plugin or MCP stdio/HTTP | Supported |
| Claude Code | MCP stdio | Supported |
| Claude Desktop | MCP stdio | Supported on Windows and macOS |
| DeepSeek Harness | MCP via the Cordis profile patch | Supported |
| Other MCP clients | MCP stdio/HTTP | Supported |
| Direct JavaScript agents | SDK with OpenAI, Anthropic, Gemini and MCP schema adapters | Supported |
| Agent Skills (OpenCode, Codex, Claude Code, Gemini CLI, Cursor, Copilot) | `~/.claude/skills` + `~/.agents/skills` | Supported |
| ChatGPT/Codex desktop | Global skills + `agents/openai.yaml` | Supported |

## Browsers

| Browser | Connection | Notes |
| --- | --- | --- |
| Chrome, Edge, Brave, Chromium | Chromium extension and CDP | Windows, macOS and Linux |
| Firefox 140+ | Firefox add-on and WebDriver BiDi | Must be launched with remote debugging. Download lifecycle events need Firefox 144 or 145. See [Firefox](firefox.md). |
| LibreWolf | Firefox add-on and WebDriver BiDi | Its Remote Agent must be enabled |

Other Chromium or Firefox derivatives need individual validation.

## Versions

The package pins an exact tested OpenCode plugin SDK. Newest client channels are tested separately; a latest-client failure is documented as a compatibility issue instead of silently changing the published dependency. Protocol, schema, capability, extension, and native-host versions are returned in every adapter contract.

The skill is the cross-provider surface. `install --client skills` copies it to the standard agent-skills locations and, for Codex, registers an enabled `[[skills.config]]` entry in `~/.codex/config.toml` (see [universal-clients.md](universal-clients.md)).
