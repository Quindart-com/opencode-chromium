/** Product metadata shared by setup, runtime reporting and the extension. */
export const harnessDefinitions = {
  codex: { label: "Codex", command: "codex", packages: ["@openai/codex"], icon: "/images/harness/codex-light.png", clientPattern: "codex", desktop: "Codex" },
  opencode: { label: "OpenCode", command: "opencode", packages: ["@opencode/cli", "opencode-ai"], icon: "/images/harness/opencode.svg", clientPattern: "opencode", desktop: null },
  dsh: { label: "DeepSeek Harness", command: "dsh", packages: ["@deepseek-ai/dsh"], icon: "/images/harness/deepseek.svg", clientPattern: "deepseek|\\bdsh\\b", desktop: null },
  "claude-code": { label: "Claude Code", command: "claude", packages: ["@anthropic-ai/claude-code"], icon: "/images/harness/claude-code.svg", clientPattern: "claude[\\s_-]*code", desktop: null },
  "claude-desktop": { label: "Claude Desktop", command: "", packages: [], icon: "/images/harness/claude-desktop.svg", clientPattern: "claude[\\s_-]*desktop", desktop: "Claude" },
} as const;
export type HarnessTarget = keyof typeof harnessDefinitions;
export type HarnessId = HarnessTarget | "opencode-mcp";
export const harnessTargets = Object.keys(harnessDefinitions) as HarnessTarget[];
export const harnessClients = [...harnessTargets, "opencode-mcp"] as const;
export const harnessLabels = { ...Object.fromEntries(harnessTargets.map(id => [id, harnessDefinitions[id].label])) as Record<HarnessTarget, string>, claude: "Claude", mcp: "MCP client", sdk: "JavaScript / CLI" };
export const harnessEnv = (id: HarnessTarget, kind: "EXECUTABLE" | "CONFIG") => "OPENCODE_BROWSER_" + id.replaceAll("-", "_").toUpperCase() + "_" + kind;
