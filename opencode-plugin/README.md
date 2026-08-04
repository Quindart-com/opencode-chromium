# OpenCode Plugin

This directory contains the OpenCode plugin and custom browser tools.

OpenCode receives the same provider-neutral core as normal custom tools. The local entrypoint exposes four tools by default: `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`.

## Plugin Entry

The canonical entrypoint is `.opencode/plugins/opencode-browser-adapter.js`, which loads the AI-first adapter (`src/ai-plugin.js`) so OpenCode exposes the same four tools as the Codex MCP adapter. Run `npm run install:opencode` from the repository root to register it globally in `~/.config/opencode/plugins/`; the global file re-exports this repository's entrypoint, so code changes apply immediately without reinstalling. The entrypoint guards against double registration when both the global and repository-local copies load.

The granular implementation in `src/plugin.js` is the internal engine for `browser-core/` and is not exposed as OpenCode tools. It remains reachable for migration only through the MCP adapter's `--toolset=legacy`.

## Skill

The skill is available at `.opencode/skills/opencode-browser-adapter/SKILL.md` and is synced globally by `npm run install:opencode`.

## Context-Saving Tools

Core action chaining combines navigate/search/interact/assert flows in one model request. Screenshots and oversized results are stored as ephemeral artifacts, while ordinary responses are bounded and summary-first.

`browser_page_search` defaults to lean, focused, lexical-first auto search. The lightweight model ranks at most 48 uncertain candidates when ready; explicit deep search retains Qwen3.

`browser_visual_map` returns visible UI boxes without screenshot payloads. It is DOM-first and only uses the optional native-host screenshot detector when DOM mapping cannot find elements or `vision: "force"` is passed.
