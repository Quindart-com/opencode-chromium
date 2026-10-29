export const harnessLabels = { codex: "Codex", opencode: "OpenCode", dsh: "DeepSeek Harness", claude: "Claude", mcp: "MCP client", sdk: "JavaScript / CLI" } as const;
export type HarnessKind = keyof typeof harnessLabels;
export interface ClientIdentity {
  harness: HarnessKind;
  harnessVersion: string | null;
  transport: "mcp" | "plugin" | "sdk";
  phase: "initialized" | "used";
  pid: number;
}
export interface HarnessConnection extends ClientIdentity {
  id: string;
  runtimeVersion: string | null;
  connectedAt: number;
  lastSeenAt: number;
  lastActionAt: number | null;
  pending: number;
  state: "responding" | "stale" | "unidentified";
}
export interface ConnectionSnapshot {
  observedAt: number;
  host: { version: string | null; pid: number };
  clients: HarnessConnection[];
}

/** Client names are hints, never authority. Do not forward arbitrary names or paths. */
export function identifyHarness(name = ""): HarnessKind {
  if (/codex/i.test(name)) return "codex";
  if (/opencode/i.test(name)) return "opencode";
  if (/deepseek|\bdsh\b/i.test(name)) return "dsh";
  if (/claude/i.test(name)) return "claude";
  return "mcp";
}
export function safeClientVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d[\w.+-]{0,49}$/.test(value) ? value : null;
}
