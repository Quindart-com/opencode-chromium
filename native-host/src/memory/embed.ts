import { record } from "../../../src/shared/values.ts";
import { EMBED_BATCH_SIZE,MEMORY_EMBED_MAX_ATTEMPTS,WRITER_FLUSH_MS,WRITER_QUEUE_CAPACITY } from "./config.ts";
import type { MemoryStorePort } from "./contracts.ts";
import type { Embedder,EmbeddingResult } from "./embedding-service.ts";
import { EmbeddingService } from "./embedding-service.ts";
import { dot,scoreFor } from "./rank.ts";
import { parseRecipeJson } from "./recipe.ts";
export interface EmbeddingRow { fingerprint: string; values: ArrayLike<number> | undefined }
type QueueItem = { fingerprint: string; text: string; attempts?: number; kind?: string };
type QueryEmbedding = { vector: number[] | Float32Array | null; model?: string | null; dims?: number | null; embeddingProfile?: string | null };
export interface MemoryCandidate {
  kind: "action" | "chain" | "action_v2" | "chain_v2";
  row: { id: number; fingerprint: string; last_seen: string; embedding_profile?: string | null; model_id?: string | null;
    confirmed_count?: number; failed_count?: number; capability?: string | null; action?: string | null; hostname?: string | null;
    verb?: string | null; label?: string | null; target_label?: string | null; safe_summary?: string | null; intent?: string | null;
    signature?: string | null; recipe_json?: string | null; steps_json?: string | null };
}
type QueryOptions = { query: string; bound: number; candidates: MemoryCandidate[]; vectors: Map<number, Float32Array>; modelId: string | null;
  kind: string; embeddingProfile?: string | null; threshold?: number; profileId?: string | null; hostname?: string | null };

export class EmbedQueue {
  private readonly service: EmbeddingService | null;
  readonly embed: ((texts: string[]) => Promise<EmbeddingResult>) | null;
  private flushing: Promise<void> | null;
  onResults: ((rows: EmbeddingRow[], model: string | null | undefined, dims: number, profile: string | null) => void) | null;
  store: MemoryStorePort | null;
  private queue: QueueItem[];
  private pendingDrop: number;
  private closed: boolean;
  private timer: ReturnType<typeof setTimeout> | null;
  private queryEmbed: ((query: string) => Promise<QueryEmbedding>) | null;
  private reindexPromise: Promise<unknown> | null;
  readonly capacity: number;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  constructor({ embed = null, onResults = null, capacity = WRITER_QUEUE_CAPACITY, store = null }: { embed?: Embedder | null; onResults?: EmbedQueue["onResults"]; capacity?: number; store?: MemoryStorePort | null } = {}) {
    this.service = embed ? new EmbeddingService(embed) : null;
    const service = this.service;
    this.embed = service ? texts => service.run(texts) : null;
    this.flushing = null;
    this.onResults = onResults;
    this.store = store;
    this.queue = [];
    this.pendingDrop = 0;
    this.closed = false;
    this.timer = null;
    this.queryEmbed = null;
    this.reindexPromise = null;
    this.capacity = capacity;
  }

  setQueryEmbedder(fn: (query: string) => Promise<QueryEmbedding>) {
    this.queryEmbed = fn;
  }

  push(item: QueueItem) {
    if (this.closed || !this.embed) return false;
    const existing = this.queue.find(pending => pending.fingerprint === item.fingerprint);
    if (existing) { existing.text = item.text; return true; }
    if (this.queue.length >= this.capacity) {
      this.pendingDrop += 1;
      this.store?.writeMeta?.("embedding_queue_drops", Number(this.store?.meta?.embedding_queue_drops ?? 0) + 1);
      return false;
    }
    this.queue.push({ ...item, attempts: item.attempts ?? 0 });
    if (this.queue.length >= EMBED_BATCH_SIZE) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, WRITER_FLUSH_MS);
      if (this.timer.unref) this.timer.unref();
    }
    return true;
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async drain() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed || !this.embed || this.queue.length === 0) return;
    while (!this.closed && this.queue.length) {
      const batch = this.queue.splice(0, EMBED_BATCH_SIZE);
      try {
        const texts = batch.map(item => item.text);
        this.store?.noteEmbeddingAttempt?.(batch.length);
        const result = await this.embed(texts);
        if (this.closed) return;
        const rows = batch.map((item, index) => ({ fingerprint: item.fingerprint, values: result.vectors[index] }));
        this.onResults?.(rows, result.model, result.dims, result.embeddingProfile ?? null);
      } catch (error) {
        // Surface embedding failures in health instead of silently dropping.
        if (this.closed) return;
        this.store?.noteEmbeddingFailure?.(error);
        for (const item of batch) {
          const attempts = (item.attempts ?? 0) + 1;
          if (attempts < MEMORY_EMBED_MAX_ATTEMPTS && !this.closed) {
            const delayMs = 1000 * 2 ** (attempts - 1);
            const timer = setTimeout(() => {
              this.retryTimers.delete(timer);
              if (!this.closed) this.push({ ...item, attempts });
            }, delayMs);
            timer.unref?.(); this.retryTimers.add(timer);
          }
        }
      }
    }
  }

  async embedQuery(store: MemoryStorePort, { query, bound, candidates, vectors, modelId, embeddingProfile = null, threshold = 0.42, profileId = null }: QueryOptions) {
    if (!this.queryEmbed || typeof query !== "string") {
      return { results: [], model: modelId, dims: null, embedding_profile: embeddingProfile, degraded: true, error: "memory_model_unavailable" };
    }
    let queryResult;
    try {
      queryResult = await this.queryEmbed(query);
    } catch (error) {
      store?.noteEmbeddingFailure?.(error);
      return { results: [], model: modelId, dims: null, embedding_profile: embeddingProfile, degraded: true, error: "memory_model_unavailable" };
    }
    const queryVector = queryResult?.vector ?? null;
    const queryModel = queryResult?.model ?? null;
    const queryDims = Number(queryResult?.dims ?? queryVector?.length ?? 0) || null;
    const queryProfile = queryResult?.embeddingProfile ?? null;
    if (!queryVector) return { results: [], model: modelId, dims: null, embedding_profile: embeddingProfile, degraded: true, error: "memory_model_unavailable" };
    const storedDims = Number(store?.meta?.dims ?? 0) || null;
    if (!embeddingProfile || queryProfile !== embeddingProfile || queryModel !== modelId || queryDims !== storedDims || queryVector.length !== storedDims) {
      this.#scheduleReindex(store);
      return { results: [], model: queryModel, dims: queryDims, embedding_profile: queryProfile, degraded: true, error: "index_stale" };
    }

    const scored = [];
    for (const [index, item] of candidates.entries()) {
      const values = vectors.get(index);
      if (!values) continue;
      const profileMismatch = item.kind.endsWith("_v2")
        ? item.row.embedding_profile !== queryProfile
        : item.row.model_id !== queryModel;
      if (values.length !== queryVector.length || profileMismatch) {
        this.#scheduleReindex(store);
        continue;
      }
      const similarity = dot(queryVector, values);
      if (!Number.isFinite(similarity)) continue;
      const row = item.row;
      const confirmed = Number(row.confirmed_count ?? 0);
      const failed = Number(row.failed_count ?? 0);
      scored.push({
        kind: item.kind,
        id: row.id,
        fingerprint: row.fingerprint,
        signature: shapeSignature(item, row),
        capability: row.capability ?? null,
        action: row.action ?? null,
        hostname: row.hostname ?? null,
        verb: row.verb ?? null,
        label: row.label ?? row.target_label ?? null,
        confidence: scoreFor(similarity, confirmed, failed),
        similarity,
        confirmed_count: confirmed,
        failed_count: failed,
        negative: failed > 0 && confirmed === 0,
        last_seen: row.last_seen,
        steps: item.kind === "chain_v2" ? parseV2Steps(row.recipe_json) : item.kind === "chain" ? parseSteps(row.steps_json) : item.kind === "action_v2" ? parseV2Steps(row.recipe_json) : undefined,
        embedding_profile: row.embedding_profile ?? null,
      });
    }
    scored.sort((a, b) => b.confidence - a.confidence || b.last_seen.localeCompare(a.last_seen) || a.id - b.id);

    // Rejection gate: candidates below the calibrated similarity threshold are
    // unrelated, and must not be returned as "least bad" matches.
    const aboveThreshold = scored.filter((item) => item.similarity >= threshold);
    const seenSteps = new Set();
    const deduped = [];
    for (const item of aboveThreshold) {
      if (item.kind === "chain_v2") {
        const key = (item.steps ?? []).map((step) => `${step.action}:${"target_label" in step ? step.target_label ?? "" : ""}`).join("|");
        if (key && seenSteps.has(key)) continue;
        if (key) seenSteps.add(key);
      }
      deduped.push(item);
    }
    const results = deduped.slice(0, bound);
    store?.usageEvent?.({ eventType: "matches_returned", stepsReused: results.length, profileId });
    if (results.some((item) => item.negative)) {
      store?.touchFailureHits?.(results.filter((item) => item.negative).map((item) => item.fingerprint));
    }
    return {
      results,
      model: modelId ?? null,
      dims: Number(store.meta.dims ?? 0) || null,
      embedding_profile: embeddingProfile,
      threshold,
      degraded: scored.length === 0,
    };
  }

  #scheduleReindex(store: MemoryStorePort) {
    if (this.reindexPromise || !store?.open || !this.embed) return;
    this.reindexPromise = Promise.resolve(store.reindex({ embed: this.embed }))
      .catch((error) => store?.noteEmbeddingFailure?.(error))
      .finally(() => { this.reindexPromise = null; });
  }

  close() {
    this.closed = true;
    this.service?.close();
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.queue = [];
  }
}

function shapeSignature(item: Pick<MemoryCandidate, "kind">, row: MemoryCandidate["row"]) {
  if (item.kind === "chain_v2") return row.safe_summary ?? `chain ${row.id}`;
  if (item.kind === "action_v2") return [row.action, row.hostname, row.target_label ?? "?"].filter(Boolean).join(" | ");
  if (item.kind === "chain") return row.intent ?? `chain ${row.id}`;
  return row.signature ?? "";
}

function parseSteps(stepsJson: string | null | undefined) {
  try {
    const steps: unknown = (JSON.parse(stepsJson ?? "[]") as unknown);
    const text = (value: unknown): string | null => typeof value === "string" ? value : null;
    return Array.isArray(steps) ? steps.map(value => { const step = record(value); return {
      position: typeof step.position === "number" ? step.position : null, capability: text(step.capability), hostname: text(step.hostname),
      verb: text(step.verb), label: text(step.label), success: step.success === true, action: text(step.action),
    }; }) : [];
  } catch { return []; }
}

function parseV2Steps(recipeJson: string | null | undefined) { return parseRecipeJson(recipeJson ?? null); }
