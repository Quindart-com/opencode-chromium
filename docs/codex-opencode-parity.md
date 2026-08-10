# Codex and OpenCode parity

Codex uses the MCP adapter; OpenCode V2 uses `src/adapters/opencode/index.js`. Both adapters consume the same registry and runtime, so they share:

- four tool names and the same compact schemas;
- profiles, sessions, tab ownership, retries, settling, approvals, and finalization;
- Snowflake-default search, explicit lexical/auto alternatives, and explicit Qwen deep search;
- the on-demand tab-scoped `network.inspect` capability pack, including the same filters, redaction, body approval, and CDP lifecycle projection;
- artifact metadata and session isolation;
- version metadata and normalized error codes.

Run `bun run test:contracts`, `bun run test:mcp`, and `bun run test:opencode` to compare the protocol envelopes without a live browser.

Both clients also load the same bundled skill. OpenCode auto-discovers skills from `.opencode/skills`, `.claude/skills`, and `.agents/skills`; this Codex build reads its user skills from `~/.codex/skills` and honors explicit `[[skills.config]]` enablement. `install --client skills` writes all three standard locations and the Codex config entry so the skill is available in both clients (see [universal-clients.md](universal-clients.md)).
