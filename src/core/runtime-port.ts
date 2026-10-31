import type { AsyncLocalStorage } from "node:async_hooks";
import type { ArtifactStore } from "./artifacts.ts";
import type { OperationResult } from "./operation-results.ts";
import type { Step,Target } from "./registry.ts";
import type { RuntimeSession } from "./runtime-types.ts";

export type ResolvedTarget = Target & { node_id?: string | number | null; id?: string | number | null };

/** Narrow port used by runtime helpers so they do not depend on the concrete runtime class. */
export interface RuntimePort {
  readonly operationScope: AsyncLocalStorage<{ frameId?: string; deadlineAt?: number }>;
  readonly artifacts: ArtifactStore;
  getSession(sessionId: string): RuntimeSession;
  invoke<K extends string>(name: K, args: Record<string, unknown>, sessionId: string): Promise<OperationResult<K>>;
  resolveTarget(step: Pick<Step, "target">, tabId: number, prior: Map<string, unknown>, sessionId: string): Promise<ResolvedTarget>;
  selectProfile(session: RuntimeSession, requested: string | null | undefined): Promise<unknown>;
}
