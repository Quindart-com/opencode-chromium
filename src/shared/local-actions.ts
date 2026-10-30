import type { HarnessTarget } from "./connections.ts";

export type LocalActionKind = "reconnect" | "diagnose" | "update";
export interface LocalAction {
  id: string; kind: LocalActionKind; target?: HarnessTarget;
  state: "queued" | "running" | "succeeded" | "waiting" | "failed"; code: string; updatedAt: number;
}
