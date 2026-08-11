# Universal clients

All supported clients call the same `AgentBrowserRuntime`.

```js
import { createBrowserAgent } from "opencode-chromium/sdk";

const agent = createBrowserAgent();
const tools = agent.tools("openai");
const result = await agent.call("browser_run", {
  profile: "Work",
  steps: [
    { id: "target", action: "find", value: "Settings" },
    { action: "click", target: { fromStep: "target" } }
  ]
});
agent.close();
```

Use `openai`, `anthropic`, `gemini`, or `mcp` for provider-specific schema syntax. These adapters change only field names and result envelopes; Snowflake-default search, safety, profiles, retries, and artifacts stay in the core.

OpenCode V2 uses the native package root export. Stable OpenCode, Codex, and other clients use the universal MCP server. The default tool surface is always four tools.

The same runtime also supports lazy capabilities. Every client requests the network manifest through `browser_observe` and executes `network.inspect` as a `browser_run` capability step; no client-specific fifth tool or schema is added. This includes OpenCode, Codex/MCP, direct OpenAI/Anthropic/Gemini SDK adapters, and the HTTP MCP deployment used by cloud clients.

## Agent Skills surface

The bundled skill ([`skills/opencode-browser-plugin/SKILL.md`](../skills/opencode-browser-plugin/SKILL.md)) follows the open [Agent Skills](https://agentskills.io) standard, so any skills-compatible client can discover it from the standard locations without a provider-specific adapter.

Install it for every compatible client at once:

```powershell
opencode-chromium install --client skills
opencode-chromium install --client skills --dry-run
opencode-chromium uninstall --client skills
```

`install --client skills` copies the skill to:

- `~/.codex/skills/opencode-browser-plugin/` — this Codex build's user skill home
- `~/.claude/skills/opencode-browser-plugin/` — Claude Code, OpenCode, Cursor, Copilot
- `~/.agents/skills/opencode-browser-plugin/` — the cross-provider standard location

For Codex it also updates `~/.codex/config.toml`: it backs up the file, removes any stale `[[skills.config]]` entry pointing at the legacy `opencode-browser-adapter` skill, and appends an enabled `[[skills.config]]` entry for the installed `SKILL.md` (this Codex build requires explicit enablement rather than pure auto-discovery). Uninstall removes the skill directories and the config entry, and never touches unrelated skills.

The skill ships with [`agents/openai.yaml`](../skills/opencode-browser-plugin/agents/openai.yaml) so ChatGPT and Codex desktop can present it in the Skills picker and declare the browser MCP connector as a dependency.
