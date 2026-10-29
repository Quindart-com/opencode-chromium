export type LocalActionKind = "reconnect" | "diagnose" | "update";
export interface LocalAction {
  id: string; kind: LocalActionKind; target?: "codex" | "opencode" | "dsh";
  state: "queued" | "running" | "succeeded" | "waiting" | "failed"; code: string; updatedAt: number;
}
