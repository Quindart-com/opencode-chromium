# 1.0 migration

This is a breaking release. Use Bun for all commands.

| Previous surface | 1.0 surface |
| --- | --- |
| npm package identity | `opencode-chromium` |
| OpenCode V1 plugin wrapper | removed; use native OpenCode V2 |
| stable OpenCode browser integration | MCP server `opencode-browser-plugin` |
| separate Codex adapter | universal MCP adapter |
| 49 default model tools | four default tools plus capability packs or explicit legacy mode |
| copied global plugin files | CLI configuration pointing at the current build |
| `npm install` / `npm run` | `bun install` / `bun run` |

## Migration steps

1. Remove stale V1 plugin registrations from client configuration.
2. Run `bun install --frozen-lockfile` and `bun run build`.
3. Register the native OpenCode V2 adapter or the MCP server, but not both for the same model context.
4. Install `skills/opencode-browser-plugin/SKILL.md` under its canonical name.
5. Preserve browser profile labels and semantic model caches; the new `AGENT_BROWSER_*` variables take precedence over old aliases.
6. Run `opencode-chromium doctor --json` and `bun run check:release`.

The old names may appear only in this migration guide as historical references. There is no V1 registration guard, installer, named-export plugin API, or provider-neutral source under a legacy directory.
