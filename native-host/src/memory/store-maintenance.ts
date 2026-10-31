import fs from "node:fs";
import { composeChainEmbedding as composeChainEmbeddingFor } from "./compose.ts";
import {
  DEFAULT_QUOTA_BYTES,
  MAX_PURGE_DAYS,
  MAX_QUOTA_BYTES,
  MIN_PURGE_DAYS,
  MIN_QUOTA_BYTES,
  SCHEMA_VERSION,
  closeDatabase,
  databasePath,
  inTransaction
} from "./config.ts";
import { prepareRows,sqlProjection } from "./database.ts";
import type { EmbeddingResult } from "./embedding-service.ts";
import { chainSearchText } from "./privacy.ts";
import { daysBetween,negativeValue,negligibleThreshold } from "./purge.ts";
import { SCHEMA_DDL } from "./schema.ts";

import { isoNow,tryRemoveAsync,type ReindexResult,type UsageEvent } from "./store-foundation.ts";
import { MemoryStoreQuery } from "./store-query.ts";

export class MemoryStore extends MemoryStoreQuery {
  reindex(options: { embed?: (texts: string[]) => Promise<EmbeddingResult>; batchSize?: number; rebuildV2?: boolean } = {}): Promise<ReindexResult> {
    if (this.reindexPromise) return this.reindexPromise;
    this.reindexPromise = this._reindex(options)
      .catch((error) => { if (this.open) this.noteEmbeddingFailure(error); throw error; })
      .finally(() => { this.reindexPromise = null; });
    return this.reindexPromise;
  }

  async _reindex({ embed = null, batchSize = 16, rebuildV2 = true }: { embed?: ((texts: string[]) => Promise<EmbeddingResult>) | null; batchSize?: number; rebuildV2?: boolean } = {}): Promise<ReindexResult> {
    if (!embed) throw new Error("Memory embeddings are unavailable");
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error("Invalid embedding batch size");
    let embedded = 0;
    const missing = prepareRows(this.db, "SELECT fingerprint, signature FROM signatures WHERE embedding IS NULL ORDER BY id DESC LIMIT 2000", sqlProjection("fingerprint", "signature")).all();
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      if (!embed) break;
      const result = await embed(batch.map((row) => row.signature));
      if (!this.open) throw new Error("Memory store closed during rebuild");
      if (result?.vectors?.length !== batch.length) throw new Error("Incomplete embedding batch");
      this.applyEmbeddings(batch.map((row, index: number) => ({ fingerprint: row.fingerprint, values: result.vectors[index] })), result.model, result.dims, result.embeddingProfile ?? null);
      embedded += batch.length;
    }
    const heads = prepareRows(this.db, "SELECT id FROM chains WHERE replaced_by IS NULL", sqlProjection("id")).all();
    for (const chain of heads) composeChainEmbeddingFor(this, chain.id);

    let v2Embedded = 0;
    if (rebuildV2 && embed) {
      // An explicit rebuild may follow a model/profile setting change. The
      // target profile is only known after `embed` returns, so rebuild every
      // live v2 row instead of comparing against the previous profile.
      const staleActions = prepareRows(this.db, "SELECT fingerprint, action, hostname, target_label, target_role FROM memory_actions_v2", sqlProjection("fingerprint", "action", "hostname", "target_label", "target_role")).all();
      const staleChains = prepareRows(this.db, "SELECT fingerprint, safe_summary FROM memory_chains_v2 WHERE replaced_by IS NULL AND safe_summary != ''", sqlProjection("fingerprint", "safe_summary")).all();
      const v2Batch = [
        ...staleActions.map((row) => ({ kind: "action", fingerprint: row.fingerprint, text: chainSearchText(row.hostname, [{ action: row.action, target_role: row.target_role, target_label: row.target_label }]) })),
        ...staleChains.map((row) => ({ kind: "chain", fingerprint: row.fingerprint, text: row.safe_summary })),
      ].filter((item) => item.text && item.text.length > 0);
      for (let start = 0; start < v2Batch.length; start += batchSize) {
        const batch = v2Batch.slice(start, start + batchSize);
        const result = await embed(batch.map((row) => row.text));
        if (!this.open) throw new Error("Memory store closed during rebuild");
        if (result?.vectors?.length !== batch.length) throw new Error("Incomplete embedding batch");
        this.applyEmbeddings(batch.map((item, index) => ({ fingerprint: "v2:" + item.kind + ":" + item.fingerprint, values: result.vectors[index] })), result.model, result.dims, result.embeddingProfile ?? null);
        v2Embedded += batch.length;
      }
    }
    this.writeMeta("last_reindex_at", isoNow());
    return { embedded, embedded_total: embedded + v2Embedded, v2_embedded: v2Embedded, heads: heads.length, model: (typeof this.meta.model_id === "string" ? this.meta.model_id : null), dims: Number(this.meta.dims ?? 0) || null };
  }

  recordHit() {
    // Deprecated: kept for API compatibility. Real usage flows through
    // memory_usage_events (see usageEvent/usageMetrics).
    this.writeMeta("memory_hits", Number(this.meta.memory_hits ?? 0) + 1);
  }

  usageEvent(event: UsageEvent) {
    inTransaction(this.db, () => this._recordUsageEvent(event));
    return { accepted: true };
  }

  touchFailureHits(fingerprints: string[]) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) return;
    const now = isoNow();
    const statement = this.db.prepare("UPDATE failure_contexts SET last_hit_at = ? WHERE signature_id IN (SELECT id FROM signatures WHERE fingerprint = ?)");
    for (const fingerprint of fingerprints) statement.run(now, fingerprint);
  }

  prune({ days = null, now = Date.now() }: { days?: number | null; now?: number } = {}) {
    const purgeDays = Number.isInteger(days) ? Math.min(Math.max(days ?? MIN_PURGE_DAYS, MIN_PURGE_DAYS), MAX_PURGE_DAYS) : Number(this.meta.purge_days ?? 7);
    const removed = this._pruneAged(purgeDays, now);
    const evicted = this._evictForQuota(now, purgeDays);
    this.writeMeta("last_prune_at", new Date(now).toISOString());
    return { removed, evicted, purge_days: purgeDays, bytes_used: this.bytesUsed(), quota_bytes: Number(this.meta.quota_bytes) };
  }

  _pruneAged(purgeDays: number, now: number) {
    let removed = 0;
    const cutoff = new Date(now - purgeDays * 86400000).toISOString();
    removed += Number(this.db.prepare("DELETE FROM memory_actions_v2 WHERE confirmed_count = 0 AND last_seen < ?").run(cutoff).changes);
    removed += Number(this.db.prepare("DELETE FROM memory_chains_v2 WHERE confirmed_count = 0 AND last_seen < ?").run(cutoff).changes);
    const contexts = prepareRows(this.db, "SELECT id, signature_id, occurred_at, last_hit_at, count FROM failure_contexts", sqlProjection("id", "signature_id", "occurred_at", "last_hit_at", "count")).all();
    const cutoffs = new Set<number>();
    const survivors = new Set();
    for (const context of contexts) {
      const lastUseMs = Date.parse(context.last_hit_at ?? context.occurred_at);
      const ageDays = daysBetween(now, lastUseMs || now);
      const chainLength = context.count;
      const value = negativeValue({ chainLength, ageDays, purgeDays });
      if (ageDays > purgeDays && value < negligibleThreshold(purgeDays)) {
        this.db.prepare("DELETE FROM failure_contexts WHERE id = ?").run(context.id);
        removed += 1;
        cutoffs.add(context.signature_id);
      } else {
        survivors.add(context.signature_id);
      }
    }
    if (cutoffs.size > 0) {
      for (const signatureId of cutoffs) {
        if (survivors.has(signatureId)) continue;
        const row = prepareRows(this.db, "SELECT confirmed_count FROM signatures WHERE id = ?", sqlProjection("confirmed_count")).get(signatureId);
        if (row && row.confirmed_count === 0) {
          this.db.prepare("DELETE FROM signatures WHERE id = ? AND confirmed_count = 0").run(signatureId);
          removed += 1;
        }
      }
      this._recomputeFailedCounts([...cutoffs]);
    }
    return removed;
  }

  _recomputeFailedCounts(signatureIds: number[]) {
    if (!signatureIds.length) return;
    const update = this.db.prepare(
      "UPDATE signatures SET failed_count = (SELECT COALESCE(SUM(count), 0) FROM failure_contexts WHERE signature_id = signatures.id AND error_code != '') WHERE id = ? AND confirmed_count > 0",
    );
    for (const signatureId of signatureIds) update.run(signatureId);
  }

  _evictForQuota(now = Date.now(), purgeDays = Number(this.meta.purge_days ?? 7)) {
    if (this.meta.enabled !== "true") return 0;
    let evicted = 0;
    let attempts = 0;
    while (this.bytesUsed() > Number(this.meta.quota_bytes) && attempts < 10000) {
      attempts += 1;
      const candidates = prepareRows(this.db, `SELECT fc.id, fc.signature_id, fc.occurred_at, fc.last_hit_at, fc.count, si.confirmed_count,
                (SELECT COUNT(*) FROM failure_contexts f2 WHERE f2.signature_id = fc.signature_id) AS context_count
         FROM failure_contexts fc JOIN signatures si ON si.id = fc.signature_id ORDER BY si.last_seen DESC`, sqlProjection("id", "signature_id", "occurred_at", "last_hit_at", "count", "confirmed_count", "context_count")).all();
      if (candidates.length === 0) break;
      let lowest = null;
      let lowestValue = Infinity;
      for (const candidate of candidates) {
        const lastUseMs = Date.parse(candidate.last_hit_at ?? candidate.occurred_at) || now;
        const ageDays = daysBetween(now, lastUseMs);
        const value = negativeValue({ chainLength: candidate.context_count + candidate.count, ageDays, purgeDays });
        if (value < lowestValue) {
          lowestValue = value;
          lowest = candidate;
        }
      }
      if (!lowest) break;
      this.db.prepare("DELETE FROM failure_contexts WHERE id = ?").run(lowest.id);
      this._recomputeFailedCounts([lowest.signature_id]);
      const left = prepareRows(this.db, "SELECT COUNT(*) AS n FROM failure_contexts WHERE signature_id = ?", sqlProjection("n")).requiredGet(lowest.signature_id).n;
      if (left === 0 && lowest.confirmed_count === 0) {
        this.db.prepare("DELETE FROM signatures WHERE id = ? AND confirmed_count = 0").run(lowest.signature_id);
      }
      evicted += 1;
    }
    this.writeMeta("quota_reached_once", this.bytesUsed() > Number(this.meta.quota_bytes) ? "true" : "false");
    if (evicted > 0) this.writeMeta("last_evict_at", new Date(now).toISOString());
    return evicted;
  }

  configure({ quota_bytes = null, purge_days = null, power_user = null }: { quota_bytes?: number | null; purge_days?: number | null; power_user?: boolean | null } = {}) {
    // Validate the entire update before persisting any part of it.
    if (quota_bytes != null && (!Number.isInteger(Number(quota_bytes)) || Number(quota_bytes) < MIN_QUOTA_BYTES || Number(quota_bytes) > MAX_QUOTA_BYTES)) throw new Error(`Quota must be between ${MIN_QUOTA_BYTES} and ${MAX_QUOTA_BYTES} bytes.`);
    if (purge_days != null && (!Number.isInteger(Number(purge_days)) || Number(purge_days) < MIN_PURGE_DAYS || Number(purge_days) > MAX_PURGE_DAYS)) throw new Error(`Purge days must be between ${MIN_PURGE_DAYS} and ${MAX_PURGE_DAYS}.`);
    if (power_user != null && typeof power_user !== "boolean") throw new Error("power_user must be a boolean.");
    this.meta = this._readMeta();
    const expanded = power_user ?? this.meta.power_user === "true";
    if (quota_bytes != null && !expanded && Number(quota_bytes) > DEFAULT_QUOTA_BYTES) throw new Error("Enable expanded storage before raising the standard quota.");
    inTransaction(this.db, () => {
      if (quota_bytes != null) this.writeMeta("quota_bytes", Number(quota_bytes));
      if (purge_days != null) this.writeMeta("purge_days", Number(purge_days));
      if (power_user != null) this.writeMeta("power_user", power_user);
      if (power_user === false && Number(this.meta.quota_bytes) > DEFAULT_QUOTA_BYTES) this.writeMeta("quota_bytes", DEFAULT_QUOTA_BYTES);
    });
    if (quota_bytes != null || power_user === false) this._evictForQuota();
    return this.status();
  }

  enable() {
    const now = isoNow();
    this.writeMeta("schema_version", SCHEMA_VERSION);
    if (this.meta.created_at === null || this.meta.created_at === "null") this.writeMeta("created_at", now);
    this.writeMeta("enabled", true);
    this.writeMeta("paused", false);
    this.writeMeta("quota_reached_once", false);
    return this.status();
  }

  disable() {
    this.writeMeta("enabled", false);
    this.writeMeta("paused", false);
    return this.status();
  }

  pause() {
    this.writeMeta("paused", true);
    return this.status();
  }

  resume() {
    this.writeMeta("paused", false);
    return this.status();
  }

  async hardDelete() {
    this.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${databasePath(this.root)}${suffix}`;
      if (!(await tryRemoveAsync(target))) {
        try {
          fs.renameSync(target, `${target}.deleting`);
          await tryRemoveAsync(`${target}.deleting`);
        } catch {
          // file is held; best effort
        }
      }
    }
    return { deleted: true, message: "Action memory store was deleted." };
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.embedQueue?.close();
    closeDatabase(this.db);
  }
}

export function openMemoryStore(options: ConstructorParameters<typeof MemoryStore>[0] = {}) {
  return new MemoryStore(options);
}

export { SCHEMA_DDL as schemaDdl };
