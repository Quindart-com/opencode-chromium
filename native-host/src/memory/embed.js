import { EMBED_BATCH_SIZE, WRITER_FLUSH_MS, WRITER_QUEUE_CAPACITY, MEMORY_EMBED_MAX_ATTEMPTS } from "./config.js";
import { dot, scoreFor } from "./rank.js";

export class EmbedQueue {
  constructor({ embed = null, onResults = null, capacity = WRITER_QUEUE_CAPACITY, store = null } = {}) {
    this.embed = embed;
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

  setQueryEmbedder(fn) {
    this.queryEmbed = fn;
  }

  push(item) {
    if (this.closed || !this.embed) return false;
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed || this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const texts = batch.map((item) => item.text);
      const result = await this.embed(texts);
      if (!result || !Array.isArray(result.vectors)) return;
      const rows = batch.map((item, index) => ({ fingerprint: item.fingerprint, values: result.vectors[index] }));
      this.onResults?.(rows, result.model, result.dims, result.embeddingProfile ?? null);
    } catch (error) {
      // Surface embedding failures in health instead of silently dropping.
      this.store?.noteEmbeddingFailure?.(error);
      for (const item of batch) {
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts < MEMORY_EMBED_MAX_ATTEMPTS && !this.closed) {
          const delayMs = 1000 * 2 ** (attempts - 1);
          setTimeout(() => {
            if (!this.closed) this.push({ ...item, attempts });
          }, delayMs).unref?.();
        }
      }
    }
  }

  async embedQuery(store, { query, bound, candidates, vectors, modelId, kind, embeddingProfile = null, threshold = 0.42 }) {
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

    store?.usageEvent?.({ eventType: "memory_search" });
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
        const key = (item.steps ?? []).map((step) => `${step.action}:${step.target_label ?? ""}`).join("|");
        if (key && seenSteps.has(key)) continue;
        if (key) seenSteps.add(key);
      }
      deduped.push(item);
    }
    const results = deduped.slice(0, bound);
    store?.usageEvent?.({ eventType: "matches_returned", stepsReused: results.length });
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

  #scheduleReindex(store) {
    if (this.reindexPromise || !store?.open || !this.embed) return;
    this.reindexPromise = Promise.resolve(store.reindex({ embed: this.embed }))
      .catch((error) => store?.noteEmbeddingFailure?.(error))
      .finally(() => { this.reindexPromise = null; });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.queue = [];
  }
}

function shapeSignature(item, row) {
  if (item.kind === "chain_v2") return row.safe_summary ?? `chain ${row.id}`;
  if (item.kind === "action_v2") return [row.action, row.hostname, row.target_label ?? "?"].filter(Boolean).join(" | ");
  if (item.kind === "chain") return row.intent ?? `chain ${row.id}`;
  return row.signature;
}

function parseSteps(stepsJson) {
  try {
    const steps = JSON.parse(stepsJson ?? "[]");
    return Array.isArray(steps) ? steps.map((step) => ({ position: step.position, capability: step.capability ?? null, hostname: step.hostname ?? null, verb: step.verb ?? null, label: step.label ?? null, success: step.success === true })) : [];
  } catch {
    return [];
  }
}

function parseV2Steps(recipeJson) {
  try {
    const steps = JSON.parse(recipeJson ?? "[]");
    return Array.isArray(steps) ? steps.map((step) => ({
      position: step.position ?? null,
      action: step.action ?? null,
      hostname: step.hostname ?? null,
      target_label: step.target_label ?? null,
      target_role: step.target_role ?? null,
      selector: step.selector ?? null,
      requiresRuntimeValue: step.requiresRuntimeValue === true,
      requiresRuntimeUrl: step.requiresRuntimeUrl === true,
      success: step.success === true,
    })) : [];
  } catch {
    return [];
  }
}
