import { EMBED_BATCH_SIZE, WRITER_FLUSH_MS, WRITER_QUEUE_CAPACITY } from "./config.js";
import { dot, scoreFor } from "./rank.js";

export class EmbedQueue {
  constructor({ embed = null, onResults = null, capacity = WRITER_QUEUE_CAPACITY } = {}) {
    this.embed = embed;
    this.onResults = onResults;
    this.queue = [];
    this.pendingDrop = 0;
    this.closed = false;
    this.timer = null;
    this.queryEmbed = null;
    this.capacity = capacity;
  }

  setQueryEmbedder(fn) {
    this.queryEmbed = fn;
  }

  push(item) {
    if (this.closed || !this.embed) return false;
    if (this.queue.length >= this.capacity) {
      this.pendingDrop += 1;
      return false;
    }
    this.queue.push(item);
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
      this.onResults?.(rows, result.model, result.dims);
    } catch {
      // embedding is best effort; signatures remain stored without vectors
    }
  }

  async embedQuery(store, { query, bound, candidates, vectors, modelId, kind }) {
    if (!this.queryEmbed || typeof query !== "string") {
      return { results: [], model: modelId, dims: null, degraded: true, error: "memory_model_unavailable" };
    }
    let queryVector;
    try {
      queryVector = await this.queryEmbed(query);
    } catch {
      return { results: [], model: modelId, dims: null, degraded: true, error: "memory_model_unavailable" };
    }
    if (!queryVector) return { results: [], model: modelId, dims: null, degraded: true, error: "memory_model_unavailable" };

    const scored = [];
    for (const [index, item] of candidates.entries()) {
      const values = vectors.get(index);
      if (!values) continue;
      const similarity = dot(queryVector, values);
      const row = item.row;
      const confirmed = Number(row.confirmed_count ?? row.confirmed_count ?? 0);
      const failed = Number(row.failed_count ?? 0);
      scored.push({
        kind: item.kind,
        id: row.id,
        fingerprint: item.kind === "chain" ? row.fingerprint : row.fingerprint,
        signature: item.kind === "chain" ? row.intent ?? `chain ${row.id}` : row.signature,
        capability: row.capability ?? null,
        hostname: row.hostname ?? null,
        verb: row.verb ?? null,
        label: row.label ?? null,
        confidence: scoreFor(similarity, confirmed, failed),
        similarity,
        confirmed_count: confirmed,
        failed_count: failed,
        negative: failed > 0 && confirmed === 0,
        last_seen: row.last_seen,
        steps: item.kind === "chain" ? parseSteps(row.steps_json) : undefined,
      });
    }
    scored.sort((a, b) => b.confidence - a.confidence || b.last_seen.localeCompare(a.last_seen) || a.id - b.id);
    const results = scored.slice(0, bound);
    if (results.length > 0) {
      store.recordHit();
      store.touchFailureHits(results.filter((item) => item.negative).map((item) => item.fingerprint));
    }
    return {
      results,
      model: modelId ?? null,
      dims: Number(store.meta.dims ?? 0) || null,
      degraded: scored.length === 0,
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.queue = [];
  }
}

function parseSteps(stepsJson) {
  try {
    const steps = JSON.parse(stepsJson ?? "[]");
    return Array.isArray(steps) ? steps.map((step) => ({ position: step.position, capability: step.capability ?? null, hostname: step.hostname ?? null, verb: step.verb ?? null, label: step.label ?? null, success: step.success === true })) : [];
  } catch {
    return [];
  }
}