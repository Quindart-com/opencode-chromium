import type { LocalAction } from "./local-actions.ts";
import { harnessDefinitions,harnessLabels,harnessTargets,type HarnessTarget } from "./harnesses.ts";
export { harnessLabels,harnessTargets,type HarnessTarget };
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
  harnesses?: Array<{ harness: HarnessTarget; installed: boolean; configured: boolean; version: string | null }>;
  actions?: LocalAction[];
}

/** Client names are hints, never authority. Do not forward arbitrary names or paths. */
export function identifyHarness(name = ""): HarnessKind {
  for (const id of harnessTargets) if (new RegExp(harnessDefinitions[id].clientPattern, "i").test(name)) return id;
  if (/claude/i.test(name)) return "claude";
  return "mcp";
}
export function safeClientVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d[\w.+-]{0,49}$/.test(value) ? value : null;
}
