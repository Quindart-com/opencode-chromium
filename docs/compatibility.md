# Compatibility matrix

| Surface | Transport | Toolset | Status |
| --- | --- | --- | --- |
| OpenCode 1.18.x | Callable native plugin | Four tools | Supported |
| OpenCode V2 | Native setup descriptor | Four tools | Supported |
| OpenCode stable | MCP stdio/HTTP | Core | Supported |
| Codex CLI/IDE | MCP stdio/HTTP | Core | Supported |
| Direct JavaScript agents | Provider schema adapters | Core | Supported |
| Agent Skills (OpenCode, Codex, Claude Code, Gemini CLI, Cursor, Copilot) | `~/.claude/skills` + `~/.agents/skills` | Skill | Supported |
| ChatGPT/Codex desktop | Global skills + `agents/openai.yaml` | Skill | Supported |
| Developer regression | MCP stdio | Debug/legacy | Explicit opt-in |

The package pins an exact tested OpenCode plugin SDK. Newest client channels are tested separately; a latest-client failure is documented as a compatibility issue instead of silently changing the published dependency. Protocol, schema, capability, extension, and native-host versions are returned in every adapter contract.

The skill is the cross-provider surface. `install --client skills` copies it to the standard agent-skills locations and, for Codex, registers an enabled `[[skills.config]]` entry in `~/.codex/config.toml` (see [universal-clients.md](universal-clients.md)).
