import type { HarnessTarget } from "./harnesses.ts";
import type { RuntimeRelease } from "./runtime-config.ts";

export type LocalActionKind = "reconnect" | "diagnose" | "update" | "rollback" | "reconcile";
export interface LocalAction {
  id: string; kind: LocalActionKind; target?: HarnessTarget;
  state: "queued" | "running" | "succeeded" | "waiting" | "blocked" | "failed"; code: string; updatedAt: number;
  details?: { component?: string; blockerCount?: number; targetVersion?: string };
}

export const CONTROL_METHODS = ["control.capabilities", "control.status", "control.update", "control.job", "control.rollback", "control.reconcile"] as const;
export type ControlMethod = typeof CONTROL_METHODS[number];

export interface ControlCapabilities {
  protocolVersion: 2;
  methods: readonly ControlMethod[];
  activation: "blue-green";
  majorUpgradeApproval: true;
  rollback: true;
}

export interface ComponentVersion {
  component: "extension" | "global-cli" | "controller" | "desired-runtime" | "active-worker" | "harness-adapter";
  version: string | null;
  state: "current" | "available" | "staging" | "draining" | "blocked" | "approval_required" | "failed" | "unknown";
  label?: string;
}

export interface ControlStatus {
  supported: true;
  protocolVersion: 2;
  enabled: boolean;
  state: string;
  desired: RuntimeRelease;
  fallback: RuntimeRelease | null;
  staged: RuntimeRelease | null;
  components: ComponentVersion[];
  jobs: LocalAction[];
  blockerCount: number;
  reason?: string;
}
