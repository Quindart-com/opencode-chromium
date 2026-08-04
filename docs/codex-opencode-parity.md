# Codex, OpenCode, and SDK parity

The canonical public contract lives in `browser-core/`. Every client uses the same four schemas and the same `AgentBrowserRuntime`; client adapters only translate the transport/tool shape.

## Adapter contract

- OpenCode loads `opencode-plugin/src/ai-plugin.js` through the `.opencode/plugins/opencode-browser-adapter.js` entrypoint (locally, or globally via `npm run install:opencode`).
- Codex and other MCP clients load `codex-adapter/mcp-server.js`, which uses the official MCP SDK.
- Direct applications use `createBrowserAgent()` and select an OpenAI, Anthropic, Gemini, or MCP schema dialect.
- All adapters dispatch to the same runtime, approval policy, artifact store, and low-level browser operations.

## Compatibility boundary

The granular implementation remains in `opencode-plugin/src/plugin.js` as the internal engine for `browser-core/`. It is exposed as tools only through `--toolset=legacy` over MCP; OpenCode always loads the four core tools. Changes to new agent behavior belong in `browser-core/`.

## Maintenance rules

- Keep one canonical Zod schema per core tool; generate provider schemas with `schema-adapters.js`.
- Do not add raw code execution to the typed core action language.
- Add a regression test for every approval, session, artifact, or response-budget change.
- Run `npm run check`; it verifies OpenCode, MCP core/legacy modes, schema budgets, and all tests.
