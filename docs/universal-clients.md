# Universal AI client integration

The browser implementation has one provider-neutral runtime and several thin protocol adapters. The runtime owns sessions, action validation, approval binding, response budgets, artifacts, and profile routing; clients only translate tool schemas and calls.

## MCP clients

Use `codex-adapter/mcp-server.js` with any client that supports MCP stdio. Use `--transport=http` for a Streamable HTTP endpoint. The MCP server is the recommended integration because it also exposes screenshot and large-result artifacts as resources.

## Direct JavaScript SDK

```js
import { createBrowserAgent } from "opencode-chromium-browser-plugin";

const browser = createBrowserAgent();

// Pick the schema dialect your model API expects.
const openAITools = browser.tools("openai");
const anthropicTools = browser.tools("anthropic");
const geminiTools = browser.tools("gemini");
const mcpTools = browser.tools("mcp");

// Dispatch a model tool call through the same validated runtime.
const result = await browser.call("browser_run", {
  sessionId: "task-123",
  steps: [
    { action: "navigate", url: "https://example.com" },
    { id: "docs", action: "find", value: "documentation" },
    { action: "click", target: { fromStep: "docs", index: 0 } }
  ],
  postObserve: { mode: "inspect" }
});
```

The schemas are generated from the same Zod definitions. Provider adapters must not fork tool behavior or maintain independent argument models.

## OpenCode

The repository-local `.opencode/plugins/opencode-browser-adapter.js` loads the four AI-first tools. Run `npm run install:opencode` to register the same entrypoint globally in `~/.config/opencode/plugins/`; a registration guard keeps the tools single-instance when both copies load.

## Profile portability

Clients can pass either a live profile ID or the exact profile label in `profile`. A sole connected profile is selected automatically. With multiple profiles, the tool returns `profile_selection_required` and a compact profile list instead of forcing a separate empty status call.

## Approval contract

The runtime prevalidates the entire chain. Uploads, clipboard access, close actions, sensitive form input, Enter/Return, and consequential click targets return one `approval_required` result before any browser side effect. The server stores that immutable request; a follow-up `browser_run` containing only the short-lived `approvalToken` executes it.

## Compatibility policy

- Default: four core tools.
- Migration: `--toolset=legacy` over MCP exposes the original 49 tools. OpenCode always loads the four core tools.
- Debugging only: `--toolset=debug` exposes both over MCP.
- Raw JavaScript evaluation is not part of the core action language; the old raw CDP tool remains legacy-only.

Provider-neutral environment names use the `AGENT_BROWSER_*` prefix (`PROFILE_REGISTRY_DIR`, `IPC_PATH`, `INSTANCE_IPC_PATH`, `SEMANTIC_DIR`, `VISUAL_DIR`, `ARTIFACT_DIR`, and `EXTENSION_ID`). Existing `OPENCODE_BROWSER_*` names remain supported as lower-priority aliases.
