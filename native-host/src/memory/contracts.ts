import type { Database } from "./database.ts";
import type { EmbeddingResult } from "./embedding-service.ts";

/** Structural store contract shared by memory helpers without importing the concrete store. */
export interface MemoryStorePort {
  readonly db: Database;
  readonly meta: Record<string, unknown>;
  readonly open?: boolean;
  writeMeta?(key: string, value: unknown): unknown;
  noteEmbeddingAttempt?(count: number): unknown;
  noteEmbeddingFailure?(error: unknown): unknown;
  usageEvent?(event: { eventType: string; stepsReused?: number; profileId?: string | null }): unknown;
  touchFailureHits?(fingerprints: string[]): unknown;
  reindex(options: { embed: (texts: string[]) => Promise<EmbeddingResult> }): Promise<unknown> | unknown;
}

export type CompositionStore = Pick<MemoryStorePort, "db" | "meta">;
