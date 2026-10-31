import { composeChainEmbedding as composeChainEmbeddingFor } from "./compose.ts";
import {
  DEFAULT_QUERY_EVENTS,
  DEFAULT_SEARCH_RESULTS,
  MAX_QUERY_EVENTS,
  MAX_SEARCH_RESULTS,
  SCHEMA_VERSION,
  STORAGE_PROFILE,
  similarityThreshold as similarityThresholdFor
} from "./config.ts";
import type { SqlValue } from "./database.ts";
import { prepareRows,sqlProjection } from "./database.ts";
import type { StatisticsScope } from "./profile-stats.ts";
import { bufferFromFloat32,float32FromBuffer } from "./rank.ts";
import {
  parseRecipeJson,
  requestRecipeFingerprint
} from "./recipe.ts";

import { MemoryStoreFoundation,canonicalV2Steps,isoNow,type LegacyChainProjection,type LegacySignatureProjection,type MemoryCandidateWithEmbedding,type SearchOptions,type SignatureRow } from "./store-foundation.ts";

export abstract class MemoryStoreQuery extends MemoryStoreFoundation {
  list({ limit = DEFAULT_QUERY_EVENTS } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    const rows = prepareRows(this.db, "SELECT * FROM signatures ORDER BY id DESC LIMIT ?", sqlProjection("id", "fingerprint", "signature", "capability", "hostname", "verb", "label", "embedding", "model_id", "confirmed_count", "failed_count", "source_session", "first_seen", "last_seen")).all(bound);
    return { events: rows.map((row) => this._shapeSignature(row)), metadata_only: true };
  }

  query({ limit = DEFAULT_QUERY_EVENTS, capability = null, hostname = null, sessionId = null, sinceId = null, untilId = null }: { limit?: number; capability?: string | null; hostname?: string | null; sessionId?: string | null; sinceId?: number | null; untilId?: number | null } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    const conditions = [];
    const params: SqlValue[] = [];
    if (capability) { conditions.push("capability = ?"); params.push(capability); }
    if (hostname) { conditions.push("hostname = ?"); params.push(hostname); }
    if (sessionId) { conditions.push("source_session = ?"); params.push(sessionId); }
    if (sinceId != null) { conditions.push("id >= ?"); params.push(sinceId); }
    if (untilId != null) { conditions.push("id <= ?"); params.push(untilId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = prepareRows(this.db, `SELECT * FROM signatures ${where} ORDER BY id DESC LIMIT ?`, sqlProjection("id", "fingerprint", "signature", "capability", "hostname", "verb", "label", "embedding", "model_id", "confirmed_count", "failed_count", "source_session", "first_seen", "last_seen")).all(...params, bound);
    return { events: rows.map((row) => this._shapeSignature(row)), metadata_only: true, model_context_disclosure: true };
  }

  _shapeSignature(row: SignatureRow) {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      signature: row.signature,
      capability: row.capability,
      hostname: row.hostname,
      verb: row.verb,
      label: row.label,
      confirmed_count: row.confirmed_count,
      failed_count: row.failed_count,
      source_session: row.source_session,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      has_embedding: row.embedding != null,
    };
  }

  showSignature(fingerprintOrId: unknown) {
    let row = null;
    if (typeof fingerprintOrId === "string") {
      row = prepareRows(this.db, "SELECT * FROM signatures WHERE fingerprint = ?", sqlProjection("id", "fingerprint", "signature", "capability", "hostname", "verb", "label", "embedding", "model_id", "confirmed_count", "failed_count", "source_session", "first_seen", "last_seen")).get(fingerprintOrId);
    } else if (typeof fingerprintOrId === "number" && Number.isInteger(fingerprintOrId) && fingerprintOrId >= 1) {
      row = prepareRows(this.db, "SELECT * FROM signatures WHERE id = ?", sqlProjection("id", "fingerprint", "signature", "capability", "hostname", "verb", "label", "embedding", "model_id", "confirmed_count", "failed_count", "source_session", "first_seen", "last_seen")).get(fingerprintOrId);
    }
    if (!row) return { event: null };
    const contexts = prepareRows(this.db, "SELECT * FROM failure_contexts WHERE signature_id = ? ORDER BY occurred_at DESC", sqlProjection("id", "signature_id", "error_code", "step_index", "chain_id", "count", "occurred_at", "last_hit_at")).all(row.id);
    return { event: this._shapeSignature(row), failure_contexts: contexts };
  }

  chainsList({ limit = 20 } = {}) {
    const rows = prepareRows(this.db, "SELECT id, fingerprint, intent, confirmed_count, failed_count, replaced_by, merged_of, first_seen, last_seen, steps_json FROM chains ORDER BY id DESC LIMIT ?", sqlProjection("id", "fingerprint", "intent", "confirmed_count", "failed_count", "replaced_by", "merged_of", "first_seen", "last_seen", "steps_json")).all(Math.min(Math.max(limit, 1), 100));
    return { chains: rows.map((row) => ({ id: row.id, fingerprint: row.fingerprint, intent: row.intent, head: row.replaced_by == null, replaced_by: row.replaced_by, confirmed_count: row.confirmed_count, failed_count: row.failed_count, first_seen: row.first_seen, last_seen: row.last_seen, steps: (JSON.parse(row.steps_json ?? "[]") as unknown) })) };
  }

  chainShow(fingerprintOrId: unknown) {
    let row = null;
    if (typeof fingerprintOrId === "string") {
      row = prepareRows(this.db, "SELECT * FROM chains WHERE fingerprint = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(fingerprintOrId);
    } else if (typeof fingerprintOrId === "number" && Number.isInteger(fingerprintOrId) && fingerprintOrId >= 1) {
      row = prepareRows(this.db, "SELECT * FROM chains WHERE id = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(fingerprintOrId);
    }
    if (!row) return { chain: null };
    return {
      chain: {
        id: row.id,
        fingerprint: row.fingerprint,
        intent: row.intent,
        confirmed_count: row.confirmed_count,
        failed_count: row.failed_count,
        source_sessions: row.source_sessions ? (JSON.parse(row.source_sessions) as unknown) : null,
        merged_of: row.merged_of ? (JSON.parse(row.merged_of) as unknown) : null,
        replaced_by: row.replaced_by,
        supersedes: row.supersedes,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        head: row.replaced_by == null,
        steps: (JSON.parse(row.steps_json ?? "[]") as unknown),
      },
    };
  }

  captureState() {
    this.meta = this._readMeta();
    return {
      enabled: this.meta.enabled === "true",
      paused: this.meta.paused === "true",
      embedding_profile: typeof this.meta.embedding_profile === "string" ? this.meta.embedding_profile : null,
    };
  }

  status(scope: StatisticsScope = {}) {
    this.meta = this._readMeta();
    const counts = prepareRows(this.db, "SELECT (SELECT COUNT(*) FROM signatures) AS signatures, (SELECT COUNT(*) FROM chains) AS chains, (SELECT COUNT(*) FROM failure_contexts) AS failure_contexts, " +
        "(SELECT COALESCE(SUM(confirmed_count), 0) FROM signatures) AS confirmed, (SELECT COALESCE(SUM(failed_count), 0) FROM signatures) AS failed, " +
        "(SELECT COUNT(*) FROM memory_actions_v2) AS actions_v2, (SELECT COUNT(*) FROM memory_chains_v2 WHERE replaced_by IS NULL AND safe_summary != '') AS chains_v2, " +
        "(SELECT COUNT(*) FROM memory_usage_events WHERE event_type = 'action_recorded') AS executions_v2, " +
        "(SELECT COUNT(*) FROM memory_usage_events WHERE event_type = 'action_recorded' AND success = 0) AS failed_executions_v2, " +
        "(SELECT COUNT(*) FROM memory_actions_v2 WHERE failed_count > 0) AS negative_actions_v2, " +
        "(SELECT COUNT(*) FROM memory_usage_events) AS usage_events", sqlProjection("signatures", "chains", "failure_contexts", "confirmed", "failed", "actions_v2", "chains_v2", "executions_v2", "failed_executions_v2", "negative_actions_v2", "usage_events")).requiredGet();
    if (scope.profileIds != null) {
      counts.actions_v2 = this.profiles.count("action", scope);
      counts.chains_v2 = this.profiles.count("chain", scope, "replaced_by IS NULL AND safe_summary != ''");
      counts.executions_v2 = this.profiles.count("event", scope, "event_type = 'action_recorded'");
      counts.failed_executions_v2 = this.profiles.count("event", scope, "event_type = 'action_recorded' AND success = 0");
      counts.negative_actions_v2 = this.profiles.negativeActions(scope);
      counts.usage_events = this.profiles.count("event", scope);
      if (!scope.includeUnattributed) for (const key of ["signatures", "chains", "failure_contexts", "confirmed", "failed"] as const) counts[key] = 0;
    }
    const usage = this.usageMetrics(scope);
    const unindexed = this.unindexedCounts();
    if (scope.profileIds != null) {
      const profile = this.meta.embedding_profile;
      const stale = typeof profile === "string" ? "embedding IS NULL OR embedding_profile IS NOT ?" : "embedding IS NULL";
      const params = typeof profile === "string" ? [profile] : [];
      unindexed.unindexed_actions = this.profiles.count("action", scope, stale, params);
      unindexed.unindexed_chains = this.profiles.count("chain", scope, `replaced_by IS NULL AND safe_summary != '' AND (${stale})`, params);
    }
    const modal = this.meta;
    return {
      supported: true,
      capabilities: { profileStatistics: true },
      scope: { profileIds: scope.profileIds == null ? null : [...new Set(scope.profileIds)], includeUnattributed: scope.profileIds == null || scope.includeUnattributed === true },
      observedAt: isoNow(),
      enabled: modal.enabled === "true",
      paused: modal.paused === "true",
      admitted: true,
      profile: STORAGE_PROFILE,
      quota_bytes: Number(modal.quota_bytes),
      bytes_used: this.bytesUsed(),
      over_quota: this.bytesUsed() > Number(modal.quota_bytes),
      purge_days: Number(modal.purge_days),
      power_user: modal.power_user === "true",
      model_id: typeof modal.model_id === "string" ? modal.model_id : null,
      dims: Number(modal.dims ?? 0) || null,
      embedding_profile: typeof modal.embedding_profile === "string" ? modal.embedding_profile : null,
      schema_version: Number(modal.schema_version ?? SCHEMA_VERSION),
      legacy_v1_tagged: modal.legacy_v1_tagged === "true",
      memory_hits: Number(modal.memory_hits ?? 0),
      dropped_events: Number(modal.dropped ?? 0),
      last_prune_at: typeof modal.last_prune_at === "string" ? modal.last_prune_at : null,
      last_evict_at: typeof modal.last_evict_at === "string" ? modal.last_evict_at : null,
      embedding_attempts: Number(modal.embedding_attempts ?? 0),
      embedding_failures: Number(modal.embedding_failures ?? 0),
      embedding_queue_drops: Number(modal.embedding_queue_drops ?? 0),
      last_embedding_error: typeof modal.last_embedding_error === "string" ? modal.last_embedding_error : null,
      last_reindex_at: typeof modal.last_reindex_at === "string" ? modal.last_reindex_at : null,
      counts: {
        signatures: counts.signatures,
        chains: counts.chains,
        failure_contexts: counts.failure_contexts,
        confirmed_total: counts.confirmed,
        failed_total: counts.failed,
        actions_v2: counts.actions_v2,
        chains_v2: counts.chains_v2,
        executions_v2: counts.executions_v2,
        failed_executions_v2: counts.failed_executions_v2,
        negative_actions_v2: counts.negative_actions_v2,
        usage_events: counts.usage_events,
        ...unindexed,
      },
      usage: usage,
      recent_daily: this._dailySeries(14, scope),
      health: this._health(),
    };
  }

  usageMetrics(scope: StatisticsScope = {}) {
    const filter = this.profiles.filter("event", scope, "memory_usage_events.id");
    const totals = prepareRows(this.db, "SELECT " +
        "SUM(CASE WHEN event_type = 'memory_search' THEN 1 ELSE 0 END) AS search_queries, " +
        "SUM(CASE WHEN event_type = 'matches_returned' THEN steps_reused ELSE 0 END) AS matches_returned, " +
        "SUM(CASE WHEN event_type = 'replay_started' THEN 1 ELSE 0 END) AS replay_attempts, " +
        "SUM(CASE WHEN event_type = 'replay_succeeded' THEN 1 ELSE 0 END) AS replay_successes, " +
        "SUM(CASE WHEN event_type = 'replay_failed' THEN 1 ELSE 0 END) AS replay_failures, " +
        "SUM(CASE WHEN event_type = 'replay_rejected' THEN 1 ELSE 0 END) AS replay_rejections, " +
        "SUM(CASE WHEN event_type IN ('replay_succeeded', 'replay_failed') THEN COALESCE(steps_reused, 0) ELSE 0 END) AS steps_reused " +
        `FROM memory_usage_events WHERE ${filter.sql}`, sqlProjection("search_queries", "matches_returned", "replay_attempts", "replay_successes", "replay_failures", "replay_rejections", "steps_reused")).requiredGet(...filter.params);
    const successes = Number(totals.replay_successes ?? 0);
    const failures = Number(totals.replay_failures ?? 0);
    const attempts = successes + failures;
    const rejections = Number(totals.replay_rejections ?? 0);
    const rejectionReasons = prepareRows(this.db, `SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS n FROM memory_usage_events WHERE event_type = 'replay_rejected' AND ${filter.sql} GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 8`, sqlProjection("reason", "n")).all(...filter.params);
    return {
      search_queries: Number(totals.search_queries ?? 0),
      matches_returned: Number(totals.matches_returned ?? 0),
      replay_attempts: Number(totals.replay_attempts ?? 0),
      replay_successes: successes,
      replay_failures: Number(totals.replay_failures ?? 0),
      // Legacy name for the rejection count, kept for already-shipped consumers.
      replay_fallbacks: rejections,
      replay_rejections: rejections,
      replay_rejections_by_reason: Object.fromEntries(rejectionReasons.map((row) => [row.reason, Number(row.n)])),
      steps_reused: Number(totals.steps_reused ?? 0),
      replay_success_rate: attempts > 0 ? Math.round((successes / attempts) * 100) : null,
    };
  }

  _dailySeries(days: number = 14, scope: StatisticsScope = {}) {
    const buckets = [];
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(now);
      day.setUTCDate(day.getUTCDate() - offset);
      buckets.push({ day: day.toISOString().slice(0, 10), confirmed: 0, failed: 0, signatures: 0 });
    }
    const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
    const filter = this.profiles.filter("event", scope, "memory_usage_events.id");
    const events = prepareRows(this.db, `SELECT SUBSTR(occurred_at, 1, 10) AS occurred_at, event_type, success, COUNT(*) AS n FROM memory_usage_events WHERE occurred_at >= ? AND ${filter.sql} GROUP BY SUBSTR(occurred_at, 1, 10), event_type, success`, sqlProjection("occurred_at", "event_type", "success", "n")).all(buckets[0]?.day ?? "", ...filter.params);
    for (const row of events) {
      const day = String(row.occurred_at).slice(0, 10);
      const bucket = byDay.get(day);
      if (!bucket) continue;
      if (row.event_type === "action_recorded") {
        if (row.success === 1) bucket.confirmed += row.n;
        else if (row.success === 0) bucket.failed += row.n;
      }
      bucket.signatures += row.n;
    }
    return buckets;
  }

  _health() {
    if (this.meta.enabled !== "true") return "disabled";
    if (this.meta.paused === "true") return "paused";
    if (this.meta.quota_reached_once === "true") return "quota_reached";
    const unindexed = this.unindexedCounts();
    const failures = Number(this.meta.embedding_failures ?? 0);
    const drops = Number(this.meta.embedding_queue_drops ?? 0);
    if (Number(this.meta.dropped ?? 0) > 0) return "events_dropped";
    if (failures > 0 && this.meta.last_embedding_error && this.meta.last_embedding_error !== "null") return "embedding_errors";
    if (drops > 0) return "queue_backpressure";
    if (unindexed.unindexed_actions + unindexed.unindexed_chains > 24) return "index_stale";
    return "ready";
  }

  async search({ query = null, limit = DEFAULT_SEARCH_RESULTS, kind = "all", hostname = null, modelId = null, includeLegacy = false, profileId = null }: SearchOptions = {}) {
    this.meta = this._readMeta();
    this._recordUsageEvent({ eventType: "memory_search", profileId });
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS) : DEFAULT_SEARCH_RESULTS;
    const activeProfile = typeof this.meta.embedding_profile === "string" ? this.meta.embedding_profile : null;

    const actionConditions = ["1 = 1"];
    const actionParams = [];
    if (hostname) { actionConditions.push("hostname = ?"); actionParams.push(hostname); }
    if (activeProfile) { actionConditions.push("embedding_profile = ?"); actionParams.push(activeProfile); }
    const actionRows = prepareRows(this.db, `SELECT id, fingerprint, action, hostname, target_label, target_role, recipe_json, confirmed_count, failed_count, last_seen, embedding, embedding_profile FROM memory_actions_v2 WHERE ${actionConditions.join(" AND ")}`, sqlProjection("id", "fingerprint", "action", "hostname", "target_label", "target_role", "recipe_json", "confirmed_count", "failed_count", "last_seen", "embedding", "embedding_profile")).all(...actionParams);

    const chainConditions = ["replaced_by IS NULL", "safe_summary != ''"];
    const chainParams = [];
    if (hostname) { chainConditions.push("EXISTS (SELECT 1 FROM json_each(memory_chains_v2.recipe_json) AS s WHERE json_extract(s.value, '$.hostname') = ?)"); chainParams.push(hostname); }
    if (activeProfile) { chainConditions.push("embedding_profile = ?"); chainParams.push(activeProfile); }
    const chainRowsV2 = prepareRows(this.db, `SELECT id, fingerprint, safe_summary, recipe_json, confirmed_count, failed_count, last_seen, embedding, embedding_profile FROM memory_chains_v2 WHERE ${chainConditions.join(" AND ")}`, sqlProjection("id", "fingerprint", "safe_summary", "recipe_json", "confirmed_count", "failed_count", "last_seen", "embedding", "embedding_profile")).all(...chainParams);

    let signatureRows: (SignatureRow | LegacySignatureProjection)[] = [];
    let chainRows: LegacyChainProjection[] = [];
    if (includeLegacy) {
      const legacySignatureConditions = ["embedding IS NOT NULL"];
      const legacyParams: SqlValue[] = [];
      if (hostname) { legacySignatureConditions.push("hostname = ?"); legacyParams.push(hostname); }
      if (modelId) { legacySignatureConditions.push("model_id = ?"); legacyParams.push(modelId); }
      signatureRows = prepareRows(this.db, `SELECT id, fingerprint, signature, capability, hostname, verb, label, confirmed_count, failed_count, last_seen, source_session, embedding, model_id FROM signatures WHERE ${legacySignatureConditions.join(" AND ")}`, sqlProjection("id", "fingerprint", "signature", "capability", "hostname", "verb", "label", "confirmed_count", "failed_count", "last_seen", "source_session", "embedding", "model_id")).all(...legacyParams);
      const legacyChainConditions = ["1 = 1"];
      const legacyChainParams: SqlValue[] = [];
      if (hostname) { legacyChainConditions.push("EXISTS (SELECT 1 FROM json_each(chains.steps_json) AS s WHERE json_extract(s.value, '$.hostname') = ?)"); legacyChainParams.push(hostname); }
      if (modelId) { legacyChainConditions.push("model_id = ?"); legacyChainParams.push(modelId); }
      chainRows = prepareRows(this.db, `SELECT id, fingerprint, intent, embedding, confirmed_count, failed_count, last_seen, steps_json, model_id FROM chains WHERE replaced_by IS NULL AND ${legacyChainConditions.join(" AND ")}`, sqlProjection("id", "fingerprint", "intent", "embedding", "confirmed_count", "failed_count", "last_seen", "steps_json", "model_id")).all(...legacyChainParams);
      for (const chain of chainRows) {
        if (!chain.embedding) {
          const composed = composeChainEmbeddingFor(this, chain.id);
          if (composed) {
            chain.embedding = bufferFromFloat32(composed);
            chain.model_id = (typeof this.meta.model_id === "string" ? this.meta.model_id : null);
          }
        }
      }
    }

    if ((signatureRows.length === 0 && chainRows.length === 0 && actionRows.length === 0 && chainRowsV2.length === 0) || !query) {
      return {
        results: [],
        model: (typeof this.meta.model_id === "string" ? this.meta.model_id : null),
        dims: Number(this.meta.dims ?? 0) || null,
        embedding_profile: activeProfile,
        degraded: true,
        ...(this.embedQueue ? {} : { error: "memory_model_unavailable" }),
      };
    }

    const byKind: () => MemoryCandidateWithEmbedding[] = ({
      all: () => [
        ...chainRowsV2.map((row) => ({ kind: "chain_v2" as const, row })),
        ...actionRows.map((row) => ({ kind: "action_v2" as const, row })),
        ...signatureRows.map((row) => ({ kind: "action" as const, row })),
        ...chainRows.map((row) => ({ kind: "chain" as const, row })),
      ],
      action: () => [
        ...actionRows.map((row) => ({ kind: "action_v2" as const, row })),
        ...signatureRows.map((row) => ({ kind: "action" as const, row })),
      ],
      chain: () => [
        ...chainRowsV2.map((row) => ({ kind: "chain_v2" as const, row })),
        ...chainRows.map((row) => ({ kind: "chain" as const, row })),
      ],
    } satisfies Record<string, () => MemoryCandidateWithEmbedding[]>) [kind as "all" | "action" | "chain"] ?? (() => []);

    const candidates = byKind();
    const vectors = new Map<number, Float32Array>();
    for (const [index, item] of candidates.entries()) {
      if (item.row.embedding) vectors.set(index, float32FromBuffer(item.row.embedding));
    }

    if (!this.embedQueue || !this.embedQueue.embedQuery) {
      return { results: [], model: (typeof this.meta.model_id === "string" ? this.meta.model_id : null), dims: Number(this.meta.dims ?? 0) || null, embedding_profile: activeProfile, degraded: true, error: "memory_model_unavailable" };
    }
    return await this.embedQueue.embedQuery(this, {
      query,
      bound,
      candidates,
      vectors,
      modelId: (typeof this.meta.model_id === "string" ? this.meta.model_id : null),
      kind,
      hostname,
      embeddingProfile: activeProfile,
      threshold: this.similarityThreshold(activeProfile),
      profileId,
    });
  }

  similarityThreshold(embeddingProfile: string | null = null) {
    return similarityThresholdFor(embeddingProfile);
  }

  // Deterministic recall for a repeated action chain. This is a pure read: the
  // caller's steps are canonicalized, compared against stored recipe
  // fingerprints, and discarded. Nothing about the request is persisted, and no
  // embedding query is needed, so a repeated workflow costs no model call.
  //
  // Only live heads (not superseded) with no recorded failure are eligible. The
  // request carries a single hostname, so recipes whose first step ran on
  // another host never match here and fall through to semantic recall.
  findRecipe({ steps = [], hostname = null }: { steps?: Parameters<typeof requestRecipeFingerprint>[0]; hostname?: string | null } = {}) {
    const fingerprint = requestRecipeFingerprint(steps, hostname);
    if (!fingerprint) return { match: null };
    const row = prepareRows(this.db, "SELECT id, fingerprint, safe_summary, recipe_json, confirmed_count, failed_count, last_seen " +
        "FROM memory_chains_v2 WHERE fingerprint = ? AND replaced_by IS NULL AND safe_summary != '' AND failed_count = 0", sqlProjection("id", "fingerprint", "safe_summary", "recipe_json", "confirmed_count", "failed_count", "last_seen")).get(fingerprint);
    if (!row) return { match: null };
    const recipe = canonicalV2Steps(parseRecipeJson(row.recipe_json));
    if (recipe.length === 0) return { match: null };
    // Defence in depth: the hostname is already part of the fingerprint, so this
    // only fires if that key derivation ever changes.
    if (hostname && recipe[0]?.hostname !== hostname) return { match: null };
    return {
      match: {
        kind: "chain_v2",
        id: row.id,
        fingerprint: row.fingerprint,
        signature: row.safe_summary,
        confidence: 1,
        similarity: 1,
        deterministic: true,
        confirmed_count: Number(row.confirmed_count ?? 0),
        failed_count: Number(row.failed_count ?? 0),
        last_seen: row.last_seen,
        steps: recipe,
      },
    };
  }

}
