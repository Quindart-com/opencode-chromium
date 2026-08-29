import fs from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_QUERY_EVENTS,
  DEFAULT_SEARCH_RESULTS,
  MAX_PURGE_DAYS,
  MAX_QUERY_EVENTS,
  MAX_QUOTA_BYTES,
  MAX_SEARCH_RESULTS,
  MIN_PURGE_DAYS,
  MIN_QUOTA_BYTES,
  SCHEMA_VERSION,
  STORAGE_PROFILE,
  closeDatabase,
  databasePath,
  defaultConfig,
  memoryRootDir,
  openDatabase,
} from "./config.js";
import { float32FromBuffer, embedBufferFromRows, bufferFromFloat32 } from "./rank.js";
import { SCHEMA_DDL } from "./schema.js";
import { buildSignature, fingerprintFor } from "./signature.js";
import { daysBetween, negativeValue, negligibleThreshold } from "./purge.js";
import { composeChainEmbedding as composeChainEmbeddingFor } from "./compose.js";
import { createHash } from "node:crypto";
import {
  DEFAULT_MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_SIMILARITY_THRESHOLDS,
  MAX_CHAIN_STEPS,
} from "./config.js";
import { sanitizeTarget, sanitizeLabel, chainSearchText } from "./privacy.js";

function shortFingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function isoNow() {
  return new Date().toISOString();
}

export class MemoryStore {
  constructor({ root = null, embedQueue = null } = {}) {
    this.root = root ?? path.resolve(memoryRootDir());
    this.embedQueue = embedQueue;
    this.db = openDatabase(this.root);
    this.db.exec(SCHEMA_DDL);
    this.meta = this.#readMeta();
    this.open = true;
    if (this.embedQueue && !this.embedQueue.store) this.embedQueue.store = this;
    this.#migrate();
  }

  // Tag legacy v1 low-level chains as non-replayable and back up the database
  // files exactly once when upgrading across schema versions.
  #migrate() {
    const current = Number(this.meta.schema_version ?? 0);
    if (current >= SCHEMA_VERSION) {
      if (this.meta.schema_version !== String(SCHEMA_VERSION)) this.writeMeta("schema_version", SCHEMA_VERSION);
      return;
    }
    if (current >= 1) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${databasePath(this.root)}${suffix}`;
        try {
          if (statSize(source) > 0) fs.copyFileSync(source, `${source}.backup-${stamp}`);
        } catch {
          // backup is best effort; the live database is untouched
        }
      }
      this.writeMeta("legacy_v1_tagged", true);
    }
    this.writeMeta("schema_version", SCHEMA_VERSION);
    this.meta = this.#readMeta();
  }

  #readMeta() {
    const config = defaultConfig();
    const rows = this.db.prepare("SELECT key, value FROM meta").all();
    for (const row of rows) {
      config[row.key] = row.value;
    }
    return config;
  }

  writeMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
    this.meta[key] = String(value);
  }

  #bumpDropped() {
    this.writeMeta("dropped", Number(this.meta.dropped ?? 0) + 1);
  }

  bytesUsed() {
    return statSize(databasePath(this.root)) + statSize(`${databasePath(this.root)}-wal`);
  }

  #ensureEnabled() {
    if (this.meta.enabled !== "true") return { accepted: false, reason: "disabled" };
    if (this.meta.paused === "true") return { accepted: false, reason: "paused" };
    if (this.meta.quota_reached_once === "true") return { accepted: false, reason: "quota_reached" };
    return { accepted: true };
  }

  record({ success = true, capability = null, hostname = null, label = null, errorCode = null, stepIndex = null, chainId = null, sessionId = null } = {}) {
    const gate = this.#ensureEnabled();
    if (!gate.accepted) return { accepted: false, reason: gate.reason };
    const parts = buildSignature({ capability, hostname, label });
    const fingerprint = fingerprintFor(parts);
    const now = isoNow();

    this.db.prepare(
      "INSERT INTO signatures (fingerprint, signature, capability, hostname, verb, label, confirmed_count, failed_count, source_session, first_seen, last_seen) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen",
    ).run(fingerprint, parts.signature, parts.capability, parts.hostname, parts.verb, parts.label, sessionId ?? null, now, now);

    const signature = this.db.prepare("SELECT id FROM signatures WHERE fingerprint = ?").get(fingerprint);
    if (!signature) return { accepted: false, reason: "storage_unavailable" };

    if (success) {
      this.db.prepare("UPDATE signatures SET confirmed_count = confirmed_count + 1, last_seen = ? WHERE fingerprint = ?").run(now, fingerprint);
    } else {
      this.db.prepare("UPDATE signatures SET failed_count = failed_count + 1, last_seen = ? WHERE fingerprint = ?").run(now, fingerprint);
      const existing = this.db.prepare(
        "SELECT id FROM failure_contexts WHERE signature_id = ? AND error_code = ? AND step_index IS ? AND chain_id IS ? LIMIT 1",
      ).get(signature.id, errorCode ?? "unknown", stepIndex ?? null, chainId ?? null);
      if (existing) {
        this.db.prepare("UPDATE failure_contexts SET count = count + 1, occurred_at = ? WHERE id = ?").run(now, existing.id);
      } else {
        this.db.prepare(
          "INSERT INTO failure_contexts (signature_id, error_code, step_index, chain_id, count, occurred_at) VALUES (?, ?, ?, ?, 1, ?)",
        ).run(signature.id, errorCode ?? "unknown", stepIndex ?? null, chainId ?? null, now);
      }
    }

    if (chainId != null) this.#noteChainStep({ chainId, fingerprint, parts, stepIndex: stepIndex ?? null, success, sessionId, now });
    this.#queueEmbed(fingerprint, parts.signature);
    this.#evictForQuota(Date.now());
    return { accepted: true, fingerprint };
  }

  #noteChainStep({ chainId, fingerprint, parts, stepIndex, success, sessionId, now }) {
    const chain = this.db.prepare("SELECT id, steps_json FROM chains WHERE fingerprint = ?").get(String(chainId));
    if (!chain) return;
    const steps = JSON.parse(chain.steps_json ?? "[]");
    if (stepIndex != null) {
      const existing = steps.find((step) => step.position === stepIndex);
      if (!existing) {
        steps.push({ position: stepIndex, fingerprint, capability: parts.capability, hostname: parts.hostname, verb: parts.verb, label: parts.label, success: success === true });
      } else {
        existing.success = existing.success || success === true;
      }
    } else if (!steps.some((step) => step.fingerprint === fingerprint)) {
      steps.push({ position: steps.length, fingerprint, capability: parts.capability, hostname: parts.hostname, verb: parts.verb, label: parts.label, success: success === true });
    }
    steps.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    this.db.prepare("UPDATE chains SET steps_json = ?, last_seen = ?, confirmed_count = confirmed_count + ?, failed_count = failed_count + ? WHERE fingerprint = ?")
      .run(JSON.stringify(steps), now, success ? 1 : 0, success ? 0 : 1, String(chainId));
    if (this.embedQueue) this.#queueEmbedChain(String(chainId));
  }

  ensureChain({ chainId, intent = null, sessionId = null }) {
    const gate = this.#ensureEnabled();
    if (!gate.accepted) return { accepted: false, reason: gate.reason };
    const now = isoNow();
    this.db.prepare(
      "INSERT INTO chains (fingerprint, intent, steps_json, source_sessions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET intent = COALESCE(excluded.intent, chains.intent), last_seen = excluded.last_seen",
    ).run(String(chainId), intent ?? null, "[]", sessionId ? JSON.stringify([sessionId]) : null, now, now);
    return { accepted: true, chainId };
  }

  // ---- Action Memory v2: high-level capture -------------------------------

  #v2Gate() {
    const gate = this.#ensureEnabled();
    if (!gate.accepted) return false;
    return true;
  }

  #recordUsageEvent({ eventType, actionId = null, chainId = null, success = null, durationMs = null, stepsReused = null, reason = null }) {
    try {
      this.db.prepare(
        "INSERT INTO memory_usage_events (occurred_at, event_type, action_id, chain_id, success, duration_ms, steps_reused, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(isoNow(), eventType, actionId, chainId, success === null ? null : success ? 1 : 0, durationMs, stepsReused, reason);
    } catch {
      // usage events are append-only telemetry; never fail capture for them
    }
  }

  recordStep({ chainId = null, position = null, action = null, hostname = null, target = null, success = true, durationMs = null, errorCode = null } = {}) {
    if (!this.#v2Gate()) return { accepted: false, reason: "disabled" };
    const safeAction = typeof action === "string" && action.length > 0 && action.length <= 64 ? action : null;
    if (!safeAction) return { accepted: false, reason: "invalid_action" };
    const safe = sanitizeTarget(target ?? {});
    const safeHostname = typeof hostname === "string" ? hostname.toLowerCase() : null;
    const now = isoNow();
    const recipe = {
      position: Number.isInteger(position) ? position : null,
      action: safeAction,
      hostname: safeHostname,
      target_label: safe.label,
      target_role: safe.role,
      selector: safe.selector,
      requiresRuntimeValue: safeAction === "fill" || safeAction === "replaceText" || safeAction === "select" || safeAction === "type" || safeAction === "navigate",
      requiresRuntimeUrl: safeAction === "navigate",
      success: success === true,
    };
    const fingerprint = shortFingerprint(JSON.stringify([safeAction, safeHostname, recipe.target_label, recipe.target_role, recipe.selector]));
    this.db.prepare(
      "INSERT INTO memory_actions_v2 (fingerprint, action, hostname, target_label, target_role, recipe_json, confirmed_count, failed_count, first_seen, last_seen) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen, confirmed_count = confirmed_count + ?, failed_count = failed_count + ?",
    ).run(fingerprint, safeAction, safeHostname, recipe.target_label, recipe.target_role, JSON.stringify(recipe), success ? 1 : 0, success ? 0 : 1, now, now, success ? 1 : 0, success ? 0 : 1);

    const row = this.db.prepare("SELECT id FROM memory_actions_v2 WHERE fingerprint = ?").get(fingerprint);
    const actionId = row?.id ?? null;
    if (actionId) {
      this.#recordUsageEvent({ eventType: "action_recorded", actionId, chainId, success, durationMs, reason: errorCode ?? null });
      this.#queueEmbedV2("action", fingerprint, chainSearchText(safeHostname, [{ action: safeAction, target_role: recipe.target_role, target_label: recipe.target_label }]));
    }
    if (chainId != null && Number.isInteger(position)) this.#appendChainStepV2(String(chainId), position, recipe, now);
    return { accepted: true, fingerprint, actionId };
  }

  #appendChainStepV2(chainId, position, recipe, now) {
    const fingerprint = shortFingerprint(`chain:${chainId}`);
    const existing = this.db.prepare("SELECT id, recipe_json FROM memory_chains_v2 WHERE fingerprint = ?").get(fingerprint);
    if (!existing) {
      this.db.prepare(
        "INSERT INTO memory_chains_v2 (fingerprint, safe_summary, recipe_json, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
      ).run(fingerprint, chainId, JSON.stringify([recipe]), now, now);
      return;
    }
    let steps = [];
    try {
      steps = JSON.parse(existing.recipe_json ?? "[]");
    } catch {
      steps = [];
    }
    if (steps.length >= MAX_CHAIN_STEPS) return;
    const at = steps.findIndex((step) => step.position === position);
    if (at === -1) steps.push(recipe);
    else steps[at] = recipe;
    steps.sort((first, second) => (first.position ?? 0) - (second.position ?? 0));
    this.db.prepare("UPDATE memory_chains_v2 SET recipe_json = ?, last_seen = ? WHERE id = ?").run(JSON.stringify(steps), now, existing.id);
  }

  finalizeChain({ chainId = null, success = true, durationMs = null } = {}) {
    if (!this.#v2Gate() || chainId == null) return { accepted: false };
    const fingerprint = shortFingerprint(`chain:${chainId}`);
    const chain = this.db.prepare("SELECT id, recipe_json FROM memory_chains_v2 WHERE fingerprint = ?").get(fingerprint);
    if (!chain) return { accepted: false };
    let steps = [];
    try {
      steps = JSON.parse(chain.recipe_json ?? "[]");
    } catch {
      steps = [];
    }
    const hostname = steps.find((step) => step.hostname)?.hostname ?? null;
    const summary = chainSearchText(hostname, steps).slice(0, 256);
    const now = isoNow();
    this.db.prepare("UPDATE memory_chains_v2 SET safe_summary = ?, confirmed_count = confirmed_count + ?, failed_count = failed_count + ?, last_seen = ? WHERE id = ?")
      .run(summary, success ? 1 : 0, success ? 0 : 1, now, chain.id);
    this.#queueEmbedV2("chain", fingerprint, summary);
    this.#recordUsageEvent({ eventType: "chain_recorded", chainId: chain.id, success, durationMs, stepsReused: steps.length });
    return { accepted: true, chainId: chain.id, steps: steps.length, summary };
  }

  markChainSuperseded({ chainId = null, supersededBy = null } = {}) {
    if (chainId == null) return { accepted: false };
    const fingerprint = shortFingerprint(`chain:${chainId}`);
    const chain = this.db.prepare("SELECT id FROM memory_chains_v2 WHERE fingerprint = ?").get(fingerprint);
    if (!chain) return { accepted: false };
    this.db.prepare("UPDATE memory_chains_v2 SET replaced_by = ? WHERE id = ?").run(supersededBy ?? chain.id, chain.id);
    return { accepted: true };
  }

  #queueEmbedV2(kind, fingerprint, text) {
    if (!this.embedQueue) return;
    const queued = this.embedQueue.push({ fingerprint: `v2:${kind}:${fingerprint}`, kind: `v2_${kind}`, text });
    if (!queued) this.writeMeta("embedding_queue_drops", Number(this.meta.embedding_queue_drops ?? 0) + 1);
  }

  applyEmbeddingV2({ fingerprint, values, modelId = null, dims = null, embeddingProfile = null }) {
    if (!values || values.length === 0) return;
    const buffer = embedBufferFromRows([values]);
    const action = this.db.prepare("SELECT id FROM memory_actions_v2 WHERE fingerprint = ?").get(fingerprint);
    if (action) {
      this.db.prepare("UPDATE memory_actions_v2 SET embedding = ?, embedding_profile = ? WHERE fingerprint = ?").run(buffer, embeddingProfile, fingerprint);
    }
    const chain = this.db.prepare("SELECT id FROM memory_chains_v2 WHERE fingerprint = ?").get(fingerprint);
    if (chain) {
      this.db.prepare("UPDATE memory_chains_v2 SET embedding = ?, embedding_profile = ? WHERE fingerprint = ?").run(buffer, embeddingProfile, fingerprint);
    }
    if (embeddingProfile) {
      this.writeMeta("embedding_profile", embeddingProfile);
      if (modelId) this.writeMeta("model_id", modelId);
      if (Number.isInteger(dims)) this.writeMeta("dims", dims);
    }
  }

  noteEmbeddingAttempt(count = 1) {
    this.writeMeta("embedding_attempts", Number(this.meta.embedding_attempts ?? 0) + count);
  }

  noteEmbeddingFailure(error) {
    this.writeMeta("embedding_failures", Number(this.meta.embedding_failures ?? 0) + 1);
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error ?? "unknown").slice(0, 160);
    this.writeMeta("last_embedding_error", message);
  }

  unindexedCounts() {
    const actions = this.db.prepare("SELECT COUNT(*) AS n FROM memory_actions_v2 WHERE embedding IS NULL").get().n;
    const chains = this.db.prepare("SELECT COUNT(*) AS n FROM memory_chains_v2 WHERE embedding IS NULL").get().n;
    return { unindexed_actions: actions, unindexed_chains: chains };
  }

  #queueEmbed(fingerprint, text) {
    if (!this.embedQueue) return;
    this.embedQueue.push({ fingerprint, kind: "signature", text });
  }

  #queueEmbedChain(chainId) {
    // chain embeddings are composed lazily at search time by composeChainFor/mergeChains
  }

  applyEmbeddings(rows, modelId, dims, embeddingProfile = null) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (modelId) this.writeMeta("model_id", modelId);
    if (Number.isInteger(dims)) this.writeMeta("dims", dims);
    if (embeddingProfile) this.writeMeta("embedding_profile", embeddingProfile);
    const legacyStatement = this.db.prepare("UPDATE signatures SET embedding = ?, model_id = ? WHERE fingerprint = ?");
    const transaction = this.db.transaction((items) => {
      for (const item of items) {
        if (!item.values || item.values.length === 0) continue;
        if (typeof item.fingerprint === "string" && item.fingerprint.startsWith("v2:")) {
          const stripped = item.fingerprint.replace(/^v2:(?:action|chain):/, "");
          this.applyEmbeddingV2({ fingerprint: stripped, values: item.values, modelId, dims, embeddingProfile });
          continue;
        }
        legacyStatement.run(embedBufferFromRows([item.values]), modelId ?? null, item.fingerprint);
      }
    });
    try {
      transaction(rows);
      this.noteEmbeddingAttempt(rows.length);
    } catch {
      // embedding application is best effort; the signature stays searchable-degraded
    }
  }

  list({ limit = DEFAULT_QUERY_EVENTS } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    const rows = this.db.prepare("SELECT * FROM signatures ORDER BY id DESC LIMIT ?").all(bound);
    return { events: rows.map((row) => this.#shapeSignature(row)), metadata_only: true };
  }

  query({ limit = DEFAULT_QUERY_EVENTS, capability = null, hostname = null, sessionId = null, sinceId = null, untilId = null } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    const conditions = [];
    const params = [];
    if (capability) { conditions.push("capability = ?"); params.push(capability); }
    if (hostname) { conditions.push("hostname = ?"); params.push(hostname); }
    if (sessionId) { conditions.push("source_session = ?"); params.push(sessionId); }
    if (sinceId != null) { conditions.push("id >= ?"); params.push(sinceId); }
    if (untilId != null) { conditions.push("id <= ?"); params.push(untilId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM signatures ${where} ORDER BY id DESC LIMIT ?`).all(...params, bound);
    return { events: rows.map((row) => this.#shapeSignature(row)), metadata_only: true, model_context_disclosure: true };
  }

  #shapeSignature(row) {
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

  showSignature(fingerprintOrId) {
    let row = null;
    if (typeof fingerprintOrId === "string") {
      row = this.db.prepare("SELECT * FROM signatures WHERE fingerprint = ?").get(fingerprintOrId);
    } else if (Number.isInteger(fingerprintOrId) && fingerprintOrId >= 1) {
      row = this.db.prepare("SELECT * FROM signatures WHERE id = ?").get(fingerprintOrId);
    }
    if (!row) return { event: null };
    const contexts = this.db.prepare("SELECT * FROM failure_contexts WHERE signature_id = ? ORDER BY occurred_at DESC").all(row.id);
    return { event: this.#shapeSignature(row), failure_contexts: contexts };
  }

  chainsList({ limit = 20 } = {}) {
    const rows = this.db.prepare(
      "SELECT id, fingerprint, intent, confirmed_count, failed_count, replaced_by, merged_of, first_seen, last_seen, steps_json FROM chains ORDER BY id DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 100));
    return { chains: rows.map((row) => ({ id: row.id, fingerprint: row.fingerprint, intent: row.intent, head: row.replaced_by == null, replaced_by: row.replaced_by, confirmed_count: row.confirmed_count, failed_count: row.failed_count, first_seen: row.first_seen, last_seen: row.last_seen, steps: JSON.parse(row.steps_json ?? "[]") })) };
  }

  chainShow(fingerprintOrId) {
    let row = null;
    if (typeof fingerprintOrId === "string") {
      row = this.db.prepare("SELECT * FROM chains WHERE fingerprint = ?").get(fingerprintOrId);
    } else if (Number.isInteger(fingerprintOrId) && fingerprintOrId >= 1) {
      row = this.db.prepare("SELECT * FROM chains WHERE id = ?").get(fingerprintOrId);
    }
    if (!row) return { chain: null };
    return {
      chain: {
        id: row.id,
        fingerprint: row.fingerprint,
        intent: row.intent,
        confirmed_count: row.confirmed_count,
        failed_count: row.failed_count,
        source_sessions: row.source_sessions ? JSON.parse(row.source_sessions) : null,
        merged_of: row.merged_of ? JSON.parse(row.merged_of) : null,
        replaced_by: row.replaced_by,
        supersedes: row.supersedes,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        head: row.replaced_by == null,
        steps: JSON.parse(row.steps_json ?? "[]"),
      },
    };
  }

  status() {
    const counts = this.db.prepare(
      "SELECT (SELECT COUNT(*) FROM signatures) AS signatures, (SELECT COUNT(*) FROM chains) AS chains, (SELECT COUNT(*) FROM failure_contexts) AS failure_contexts, " +
        "(SELECT COALESCE(SUM(confirmed_count), 0) FROM signatures) AS confirmed, (SELECT COALESCE(SUM(failed_count), 0) FROM signatures) AS failed, " +
        "(SELECT COUNT(*) FROM memory_actions_v2) AS actions_v2, (SELECT COUNT(*) FROM memory_chains_v2 WHERE replaced_by IS NULL) AS chains_v2, " +
        "(SELECT COUNT(*) FROM memory_usage_events) AS usage_events",
    ).get();
    const usage = this.usageMetrics();
    const unindexed = this.unindexedCounts();
    const modal = this.meta;
    return {
      supported: true,
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
        usage_events: counts.usage_events,
        ...unindexed,
      },
      usage: usage,
      recent_daily: this.#dailySeries(),
      health: this.#health(),
    };
  }

  usageMetrics() {
    const totals = this.db.prepare(
      "SELECT " +
        "SUM(CASE WHEN event_type = 'memory_search' THEN 1 ELSE 0 END) AS search_queries, " +
        "SUM(CASE WHEN event_type = 'matches_returned' THEN steps_reused ELSE 0 END) AS matches_returned, " +
        "SUM(CASE WHEN event_type = 'replay_attempt' THEN 1 ELSE 0 END) AS replay_attempts, " +
        "SUM(CASE WHEN event_type = 'replay_attempt' AND success = 1 THEN 1 ELSE 0 END) AS replay_successes, " +
        "SUM(CASE WHEN event_type = 'replay_attempt' AND success = 0 THEN 1 ELSE 0 END) AS replay_failures, " +
        "SUM(CASE WHEN event_type = 'replay_fallback' THEN 1 ELSE 0 END) AS replay_fallbacks, " +
        "SUM(CASE WHEN event_type = 'replay_attempt' THEN COALESCE(steps_reused, 0) ELSE 0 END) AS steps_reused " +
        "FROM memory_usage_events",
    ).get();
    const attempts = Number(totals.replay_attempts ?? 0);
    const successes = Number(totals.replay_successes ?? 0);
    return {
      search_queries: Number(totals.search_queries ?? 0),
      matches_returned: Number(totals.matches_returned ?? 0),
      replay_attempts: attempts,
      replay_successes: successes,
      replay_failures: Number(totals.replay_failures ?? 0),
      replay_fallbacks: Number(totals.replay_fallbacks ?? 0),
      steps_reused: Number(totals.steps_reused ?? 0),
      replay_success_rate: attempts > 0 ? Math.round((successes / attempts) * 100) : null,
    };
  }

  #dailySeries(days = 14) {
    const buckets = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(now);
      day.setDate(day.getDate() - offset);
      buckets.push({ day: day.toISOString().slice(0, 10), confirmed: 0, failed: 0, signatures: 0 });
    }
    const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
    const events = this.db.prepare(
      "SELECT occurred_at, event_type, success, COUNT(*) AS n FROM memory_usage_events WHERE occurred_at >= ? GROUP BY occurred_at, event_type, success",
    ).all(buckets[0]?.day ?? "");
    for (const row of events) {
      const day = String(row.occurred_at).slice(0, 10);
      const bucket = byDay.get(day);
      if (!bucket) continue;
      if (row.event_type === "chain_recorded" || row.event_type === "replay_attempt") {
        if (row.success === 1) bucket.confirmed += row.n;
        else if (row.success === 0) bucket.failed += row.n;
      }
      bucket.signatures += row.n;
    }
    return buckets;
  }

  #health() {
    if (this.meta.enabled !== "true") return "disabled";
    if (this.meta.paused === "true") return "paused";
    if (this.meta.quota_reached_once === "true") return "quota_reached";
    const unindexed = this.unindexedCounts();
    const failures = Number(this.meta.embedding_failures ?? 0);
    const drops = Number(this.meta.embedding_queue_drops ?? 0);
    if (Number(this.meta.dropped ?? 0) > 0) return "events_dropped";
    if (failures > 0) return "embedding_errors";
    if (drops > 0) return "queue_backpressure";
    if (unindexed.unindexed_actions + unindexed.unindexed_chains > 24) return "index_stale";
    return "ready";
  }

  async search({ query = null, limit = DEFAULT_SEARCH_RESULTS, kind = "all", hostname = null, modelId = null, includeLegacy = false } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS) : DEFAULT_SEARCH_RESULTS;
    const activeProfile = typeof this.meta.embedding_profile === "string" ? this.meta.embedding_profile : null;

    const actionConditions = ["1 = 1"];
    const actionParams = [];
    if (hostname) { actionConditions.push("hostname = ?"); actionParams.push(hostname); }
    if (activeProfile) { actionConditions.push("embedding_profile = ?"); actionParams.push(activeProfile); }
    const actionRows = this.db.prepare(
      `SELECT id, fingerprint, action, hostname, target_label, target_role, recipe_json, confirmed_count, failed_count, last_seen, embedding, embedding_profile FROM memory_actions_v2 WHERE ${actionConditions.join(" AND ")}`,
    ).all(...actionParams);

    const chainConditions = ["replaced_by IS NULL"];
    const chainParams = [];
    if (hostname) { chainConditions.push("EXISTS (SELECT 1 FROM json_each(memory_chains_v2.recipe_json) AS s WHERE json_extract(s.value, '$.hostname') = ?)"); chainParams.push(hostname); }
    if (activeProfile) { chainConditions.push("embedding_profile = ?"); chainParams.push(activeProfile); }
    const chainRowsV2 = this.db.prepare(
      `SELECT id, fingerprint, safe_summary, recipe_json, confirmed_count, failed_count, last_seen, embedding, embedding_profile FROM memory_chains_v2 WHERE ${chainConditions.join(" AND ")}`,
    ).all(...chainParams);

    let signatureRows = [];
    let chainRows = [];
    if (includeLegacy) {
      const legacySignatureConditions = ["embedding IS NOT NULL"];
      const legacyParams = [];
      if (hostname) { legacySignatureConditions.push("hostname = ?"); legacyParams.push(hostname); }
      if (modelId) { legacySignatureConditions.push("model_id = ?"); legacyParams.push(modelId); }
      signatureRows = this.db.prepare(
        `SELECT id, fingerprint, signature, capability, hostname, verb, label, confirmed_count, failed_count, last_seen, source_session, embedding FROM signatures WHERE ${legacySignatureConditions.join(" AND ")}`,
      ).all(...legacyParams);
      const legacyChainConditions = ["1 = 1"];
      const legacyChainParams = [];
      if (hostname) { legacyChainConditions.push("EXISTS (SELECT 1 FROM json_each(chains.steps_json) AS s WHERE json_extract(s.value, '$.hostname') = ?)"); legacyChainParams.push(hostname); }
      if (modelId) { legacyChainConditions.push("model_id = ?"); legacyChainParams.push(modelId); }
      chainRows = this.db.prepare(
        `SELECT id, fingerprint, intent, embedding, confirmed_count, failed_count, last_seen, steps_json FROM chains WHERE replaced_by IS NULL AND ${legacyChainConditions.join(" AND ")}`,
      ).all(...legacyChainParams);
      for (const chain of chainRows) {
        if (!chain.embedding) {
          const composed = composeChainEmbeddingFor(this, chain.id);
          if (composed) chain.embedding = composed;
        }
      }
    }

    if ((signatureRows.length === 0 && chainRows.length === 0 && actionRows.length === 0 && chainRowsV2.length === 0) || !query) {
      return {
        results: [],
        model: this.meta.model_id ?? null,
        dims: Number(this.meta.dims ?? 0) || null,
        embedding_profile: activeProfile,
        degraded: true,
        ...(this.embedQueue ? {} : { error: "memory_model_unavailable" }),
      };
    }

    const byKind = {
      all: () => [
        ...chainRowsV2.map((row) => ({ kind: "chain_v2", row })),
        ...actionRows.map((row) => ({ kind: "action_v2", row })),
        ...signatureRows.map((row) => ({ kind: "action", row })),
        ...chainRows.map((row) => ({ kind: "chain", row })),
      ],
      action: () => [
        ...actionRows.map((row) => ({ kind: "action_v2", row })),
        ...signatureRows.map((row) => ({ kind: "action", row })),
      ],
      chain: () => [
        ...chainRowsV2.map((row) => ({ kind: "chain_v2", row })),
        ...chainRows.map((row) => ({ kind: "chain", row })),
      ],
    }[kind] ?? (() => []);

    const candidates = byKind();
    const vectors = new Map();
    for (const [index, item] of candidates.entries()) {
      if (item.row.embedding) vectors.set(index, float32FromBuffer(item.row.embedding));
    }

    if (!this.embedQueue || !this.embedQueue.embedQuery) {
      return { results: [], model: this.meta.model_id ?? null, dims: Number(this.meta.dims ?? 0) || null, embedding_profile: activeProfile, degraded: true, error: "memory_model_unavailable" };
    }
    return await this.embedQueue.embedQuery(this, {
      query,
      bound,
      candidates,
      vectors,
      modelId: this.meta.model_id ?? null,
      kind,
      hostname,
      embeddingProfile: activeProfile,
      threshold: this.similarityThreshold(activeProfile),
    });
  }

  similarityThreshold(embeddingProfile = null) {
    if (embeddingProfile && MEMORY_SIMILARITY_THRESHOLDS[embeddingProfile] !== undefined) {
      return MEMORY_SIMILARITY_THRESHOLDS[embeddingProfile];
    }
    return DEFAULT_MEMORY_SIMILARITY_THRESHOLD;
  }

  async reindex({ embed = null, batchSize = 16, rebuildV2 = true } = {}) {
    let embedded = 0;
    const missing = this.db.prepare("SELECT fingerprint, signature FROM signatures WHERE embedding IS NULL ORDER BY id DESC LIMIT 2000").all();
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      if (!embed) break;
      const result = await embed(batch.map((row) => row.signature)).catch(() => null);
      if (!result?.vectors?.length) break;
      this.applyEmbeddings(batch.map((row, index) => ({ fingerprint: row.fingerprint, values: result.vectors[index] })), result.model, result.dims, result.embeddingProfile ?? null);
      embedded += batch.length;
    }
    const heads = this.db.prepare("SELECT id FROM chains WHERE replaced_by IS NULL").all();
    for (const chain of heads) composeChainEmbeddingFor(this, chain.id);

    let v2Embedded = 0;
    if (rebuildV2 && embed) {
      const staleActions = this.db.prepare("SELECT fingerprint, action, hostname, target_label, target_role FROM memory_actions_v2 WHERE embedding IS NULL OR embedding_profile IS ?").all(this.meta.embedding_profile ?? "__none__");
      const staleChains = this.db.prepare("SELECT fingerprint, safe_summary FROM memory_chains_v2 WHERE (embedding IS NULL OR embedding_profile IS ?) AND replaced_by IS NULL").all(this.meta.embedding_profile ?? "__none__");
      const v2Batch = [
        ...staleActions.map((row) => ({ fingerprint: row.fingerprint, text: chainSearchText(row.hostname, [{ action: row.action, target_role: row.target_role, target_label: row.target_label }]) })),
        ...staleChains.map((row) => ({ fingerprint: row.fingerprint, text: row.safe_summary })),
      ].filter((item) => item.text && item.text.length > 0);
      for (let start = 0; start < v2Batch.length; start += batchSize) {
        const batch = v2Batch.slice(start, start + batchSize);
        const result = await embed(batch.map((row) => row.text)).catch(() => null);
        if (!result?.vectors?.length) break;
        for (const [index, item] of batch.entries()) {
          this.applyEmbeddingV2({ fingerprint: item.fingerprint, values: result.vectors[index], modelId: result.model, dims: result.dims, embeddingProfile: result.embeddingProfile ?? null });
          v2Embedded += 1;
        }
      }
    }
    this.writeMeta("last_reindex_at", isoNow());
    return { embedded, embedded_total: embedded + v2Embedded, v2_embedded: v2Embedded, heads: heads.length, model: this.meta.model_id ?? null, dims: Number(this.meta.dims ?? 0) || null };
  }

  recordHit() {
    // Deprecated: kept for API compatibility. Real usage flows through
    // memory_usage_events (see usageEvent/usageMetrics).
    this.writeMeta("memory_hits", Number(this.meta.memory_hits ?? 0) + 1);
  }

  usageEvent(event) {
    this.#recordUsageEvent(event);
    return { accepted: true };
  }

  touchFailureHits(fingerprints) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) return;
    const now = isoNow();
    const statement = this.db.prepare("UPDATE failure_contexts SET last_hit_at = ? WHERE signature_id IN (SELECT id FROM signatures WHERE fingerprint = ?)");
    for (const fingerprint of fingerprints) statement.run(now, fingerprint);
  }

  prune({ days = null, now = Date.now() } = {}) {
    const purgeDays = Number.isInteger(days) ? Math.min(Math.max(days, MIN_PURGE_DAYS), MAX_PURGE_DAYS) : Number(this.meta.purge_days ?? 7);
    const removed = this.#pruneAged(purgeDays, now);
    const evicted = this.#evictForQuota(now, purgeDays);
    this.writeMeta("last_prune_at", new Date(now).toISOString());
    return { removed, evicted, purge_days: purgeDays, bytes_used: this.bytesUsed(), quota_bytes: Number(this.meta.quota_bytes) };
  }

  #pruneAged(purgeDays, now) {
    let removed = 0;
    const contexts = this.db.prepare("SELECT id, signature_id, occurred_at, last_hit_at, count FROM failure_contexts").all();
    const cutoffs = new Set();
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
        const row = this.db.prepare("SELECT confirmed_count FROM signatures WHERE id = ?").get(signatureId);
        if (row && row.confirmed_count === 0) {
          this.db.prepare("DELETE FROM signatures WHERE id = ? AND confirmed_count = 0").run(signatureId);
          removed += 1;
        }
      }
      this.#recomputeFailedCounts([...cutoffs]);
    }
    return removed;
  }

  #recomputeFailedCounts(signatureIds) {
    if (!signatureIds.length) return;
    const update = this.db.prepare(
      "UPDATE signatures SET failed_count = (SELECT COALESCE(SUM(count), 0) FROM failure_contexts WHERE signature_id = signatures.id AND error_code != '') WHERE id = ? AND confirmed_count > 0",
    );
    for (const signatureId of signatureIds) update.run(signatureId);
  }

  #evictForQuota(now = Date.now(), purgeDays = Number(this.meta.purge_days ?? 7)) {
    if (this.meta.enabled !== "true") return 0;
    let evicted = 0;
    let attempts = 0;
    while (this.bytesUsed() > Number(this.meta.quota_bytes) && attempts < 10000) {
      attempts += 1;
      const candidates = this.db.prepare(
        `SELECT fc.id, fc.signature_id, fc.occurred_at, fc.last_hit_at, fc.count, si.confirmed_count,
                (SELECT COUNT(*) FROM failure_contexts f2 WHERE f2.signature_id = fc.signature_id) AS context_count
         FROM failure_contexts fc JOIN signatures si ON si.id = fc.signature_id ORDER BY si.last_seen DESC`,
      ).all();
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
      this.#recomputeFailedCounts([lowest.signature_id]);
      const left = this.db.prepare("SELECT COUNT(*) AS n FROM failure_contexts WHERE signature_id = ?").get(lowest.signature_id).n;
      if (left === 0 && lowest.confirmed_count === 0) {
        this.db.prepare("DELETE FROM signatures WHERE id = ? AND confirmed_count = 0").run(lowest.signature_id);
      }
      evicted += 1;
    }
    this.writeMeta("quota_reached_once", this.bytesUsed() > Number(this.meta.quota_bytes) ? "true" : "false");
    if (evicted > 0) this.writeMeta("last_evict_at", new Date(now).toISOString());
    return evicted;
  }

  configure({ quota_bytes = null, purge_days = null, power_user = null } = {}) {
    if (quota_bytes != null) {
      const quota = Number(quota_bytes);
      if (!Number.isInteger(quota) || quota < MIN_QUOTA_BYTES || quota > MAX_QUOTA_BYTES) throw new Error(`Quota must be between ${MIN_QUOTA_BYTES} and ${MAX_QUOTA_BYTES} bytes.`);
      this.writeMeta("quota_bytes", quota);
      this.#evictForQuota();
    }
    if (purge_days != null) {
      const days = Number(purge_days);
      if (!Number.isInteger(days) || days < MIN_PURGE_DAYS || days > MAX_PURGE_DAYS) throw new Error(`Purge days must be between ${MIN_PURGE_DAYS} and ${MAX_PURGE_DAYS}.`);
      this.writeMeta("purge_days", days);
    }
    if (power_user != null) {
      if (typeof power_user !== "boolean") throw new Error("power_user must be a boolean.");
      this.writeMeta("power_user", power_user);
    }
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

  exportJson() {
    const signatures = this.db.prepare("SELECT signature, capability, hostname, verb, label, confirmed_count, failed_count, source_session, first_seen, last_seen FROM signatures ORDER BY id").all();
    const chains = this.db.prepare("SELECT fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, merged_of, first_seen, last_seen FROM chains ORDER BY id").all();
    const failures = this.db.prepare(
      "SELECT fc.error_code, fc.step_index, fc.count, fc.occurred_at, si.signature FROM failure_contexts fc JOIN signatures si ON si.id = fc.signature_id ORDER BY fc.id",
    ).all();
    return {
      profile: STORAGE_PROFILE,
      schema_version: SCHEMA_VERSION,
      exported_at: isoNow(),
      signatures,
      chains,
      failures,
    };
  }

  importJson(payload) {
    if (!payload || typeof payload !== "object") throw new Error("Invalid memory export payload.");
    const now = isoNow();
    let imported = 0;
    try {
      this.db.transaction(() => {
        const upsert = this.db.prepare(
          "INSERT INTO signatures (fingerprint, signature, capability, hostname, verb, label, confirmed_count, failed_count, source_session, first_seen, last_seen) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(fingerprint) DO UPDATE SET confirmed_count = confirmed_count + excluded.confirmed_count, failed_count = failed_count + excluded.failed_count",
        );
        const idByFingerprint = new Map();
        for (const record of Array.isArray(payload.signatures) ? payload.signatures : []) {
          const parts = buildSignature({ capability: record.capability ?? record.signature ?? null, hostname: record.hostname ?? null, label: record.label ?? null });
          const signatureText = typeof record.signature === "string" ? record.signature : parts.signature;
          const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : fingerprintFor({ signature: signatureText });
          upsert.run(
            fingerprint,
            signatureText,
            record.capability ?? parts.capability ?? "unknown",
            record.hostname ?? parts.hostname,
            record.verb ?? parts.verb ?? "unknown",
            record.label ?? parts.label,
            Number(record.confirmed_count ?? 0),
            Number(record.failed_count ?? 0),
            record.source_session ?? null,
            record.first_seen ?? now,
            record.last_seen ?? now,
          );
          idByFingerprint.set(fingerprint, this.db.prepare("SELECT id FROM signatures WHERE fingerprint = ?").get(fingerprint).id);
          imported += 1;
        }
        const insertFailure = this.db.prepare("INSERT OR IGNORE INTO failure_contexts (signature_id, error_code, step_index, count, occurred_at) VALUES (?, ?, ?, ?, ?)");
        for (const failure of Array.isArray(payload.failures) ? payload.failures : []) {
          const parts = buildSignature({ capability: failure.signature ?? null, hostname: null, label: null });
          const fingerprint = typeof failure.fingerprint === "string" ? failure.fingerprint : fingerprintFor({ signature: parts.signature });
          const signatureId = idByFingerprint.get(fingerprint);
          if (!signatureId) continue;
          insertFailure.run(signatureId, String(failure.error_code ?? "unknown"), failure.step_index ?? null, Number(failure.count ?? 1), failure.occurred_at ?? now);
        }
        const insertChain = this.db.prepare(
          "INSERT INTO chains (fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, merged_of, first_seen, last_seen) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET confirmed_count = confirmed_count + excluded.confirmed_count",
        );
        for (const chain of Array.isArray(payload.chains) ? payload.chains : []) {
          insertChain.run(
            String(chain.fingerprint ?? `imported-${Math.random().toString(36).slice(2)}`),
            chain.intent ?? null,
            JSON.stringify(Array.isArray(chain.steps) ? chain.steps : []),
            Number(chain.confirmed_count ?? 0),
            Number(chain.failed_count ?? 0),
            chain.source_sessions ?? null,
            chain.merged_of ?? null,
            chain.first_seen ?? now,
            chain.last_seen ?? now,
          );
        }
      })();
    } catch {
      throw new Error("Invalid memory export payload.");
    }
    return { imported };
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

function statSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function tryRemoveSync(filePath) {
  const start = Date.now();
  for (;;) {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      if (Date.now() - start > 3000) return false;
      const started = Date.now();
      while (Date.now() - started < 20) { /* wait for the filesystem lock to release */ }
    }
  }
}

async function tryRemoveAsync(filePath) {
  const start = Date.now();
  for (;;) {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      if (Date.now() - start > 3000) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function openMemoryStore(options = {}) {
  return new MemoryStore(options);
}

export { SCHEMA_DDL as schemaDdl };