import fs,{ statSync } from "node:fs";
import path from "node:path";
import { stepsOf } from "./compose.ts";
import {
  MAX_CHAIN_STEPS,
  SCHEMA_VERSION,
  databasePath,
  defaultConfig,
  inTransaction,
  memoryRootDir,
  openDatabase
} from "./config.ts";
import { prepareRows,sqlProjection } from "./database.ts";
import type { EmbedQueue,EmbeddingRow,MemoryCandidate } from "./embed.ts";
import type { EmbeddingResult } from "./embedding-service.ts";
import { chainSearchText } from "./privacy.ts";
import { ProfileStatistics } from "./profile-stats.ts";
import { embedBufferFromRows } from "./rank.ts";
import type { RecipeStep } from "./recipe.ts";
import {
  canonicalRecipeSteps,
  chainV2Fingerprint,
  parseRecipeJson,
  recipeRecord,
  shortFingerprint
} from "./recipe.ts";
import { SCHEMA_DDL } from "./schema.ts";
import { buildSignature,fingerprintFor } from "./signature.ts";

export function isoNow() {
  return new Date().toISOString();
}

export function canonicalV2Steps(steps: readonly RecipeStep[]): RecipeStep[] {
  const ordered = [...steps].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return canonicalRecipeSteps(ordered).map((step, index) => ({ ...step, success: ordered[index]?.success === true }));
}

export function recipeIdentity(step: RecipeStep) {
  return JSON.stringify([
    step.action, step.hostname, step.target_label, step.target_role, step.selector,
    step.requiresRuntimeValue === true, step.requiresRuntimeUrl === true,
  ]);
}

export function mergeV2Overlap(first: RecipeStep[], second: RecipeStep[]) {
  const maximum = Math.min(first.length, second.length);
  for (let size = maximum; size >= 2; size -= 1) {
    const firstSuffix = first.slice(-size).map(recipeIdentity);
    const secondPrefix = second.slice(0, size).map(recipeIdentity);
    if (firstSuffix.every((value: string, index: number) => value === secondPrefix[index])) {
      return canonicalV2Steps([...first, ...second.slice(size)]);
    }
    const secondSuffix = second.slice(-size).map(recipeIdentity);
    const firstPrefix = first.slice(0, size).map(recipeIdentity);
    if (secondSuffix.every((value: string, index: number) => value === firstPrefix[index])) {
      return canonicalV2Steps([...second, ...first.slice(size)]);
    }
  }
  return null;
}

export type RecordOptions = { success?: boolean; capability?: string | null; hostname?: string | null; label?: string | null; errorCode?: string | null; stepIndex?: number | null; chainId?: string | number | null; sessionId?: string | null };
export type UsageEvent = { eventType: string; actionId?: number | null; chainId?: number | string | null; success?: boolean | null; durationMs?: number | null; stepsReused?: number | null; reason?: string | null; profileId?: string | null };
export type RecordStepOptions = { chainId?: string | number | null; position?: number | null; action?: string | null; hostname?: string | null; target?: unknown; success?: boolean; durationMs?: number | null; errorCode?: string | null; profileId?: string | null };
export type FinalizeOptions = { chainId?: string | number | null; success?: boolean; durationMs?: number | null; supersedes?: number | null; profileId?: string | null };
export type SearchOptions = { query?: string | null; limit?: number; kind?: string; hostname?: string | null; modelId?: string | null; includeLegacy?: boolean; profileId?: string | null };
export type LegacySignatureProjection = Omit<SignatureRow, "first_seen">;
export type LegacyChainProjection = { id: number; fingerprint: string; intent: string | null; embedding: Uint8Array | null; confirmed_count: number; failed_count: number; last_seen: string; steps_json: string; model_id: string | null };
export type MemoryCandidateWithEmbedding = MemoryCandidate & { row: MemoryCandidate["row"] & { embedding: Uint8Array | null } };
export type SignatureRow = { id: number; fingerprint: string; signature: string; capability: string; hostname: string | null; verb: string; label: string | null; confirmed_count: number; failed_count: number; source_session: string | null; first_seen: string; last_seen: string; embedding: Uint8Array | null; model_id?: string | null };
export interface ReindexResult { embedded: number; embedded_total: number; v2_embedded: number; heads: number; model: string | number | boolean | null; dims: number | null }
export abstract class MemoryStoreFoundation {
  readonly root: string;
  readonly embedQueue: EmbedQueue | null;
  readonly db: ReturnType<typeof openDatabase>;
  readonly profiles: ProfileStatistics;
  meta: Record<string, string | number | boolean | null>;
  open: boolean;
  reindexPromise: Promise<ReindexResult> | null = null;
  constructor({ root = null, embedQueue = null }: { root?: string | null; embedQueue?: EmbedQueue | null } = {}) {
    this.root = root ?? path.resolve(memoryRootDir());
    this.embedQueue = embedQueue;
    this.db = openDatabase(this.root);
    this.db.exec(SCHEMA_DDL);
    this.profiles = new ProfileStatistics(this.db);
    this.meta = this._readMeta();
    this.open = true;
    if (this.embedQueue && !this.embedQueue.store) this.embedQueue.store = this;
    try { this._migrate(); } catch (error) { this.db.close(); throw error; }
    this.recoverEmbeddings();
  }

  // Tag legacy v1 low-level chains as non-replayable and back up the database
  // files exactly once when upgrading across schema versions.
  _migrate() {
    const current = Number(this.meta.schema_version ?? 0);
    if (current >= SCHEMA_VERSION) {
      if (this.meta.schema_version !== String(SCHEMA_VERSION)) this.writeMeta("schema_version", SCHEMA_VERSION);
      return;
    }
    if (current >= 1) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      // SQLite creates a consistent snapshot, including committed WAL data.
      this.db.prepare("VACUUM INTO ?").run(`${databasePath(this.root)}.backup-${stamp}`);
      if (current < 2) this.writeMeta("legacy_v1_tagged", true);
    }
    this.writeMeta("schema_version", SCHEMA_VERSION);
    this.meta = this._readMeta();
  }

  _readMeta() {
    const config: Record<string, string | number | boolean | null> = defaultConfig();
    const rows = prepareRows(this.db, "SELECT key, value FROM meta", sqlProjection("key", "value")).all();
    for (const row of rows) {
      config[row.key] = row.value;
    }
    return config;
  }

  writeMeta(key: string, value: string|number|boolean|null) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
    this.meta[key] = String(value);
  }

  bytesUsed() {
    return statSize(databasePath(this.root)) + statSize(`${databasePath(this.root)}-wal`);
  }

  _ensureEnabled() {
    this.meta = this._readMeta();
    if (this.meta.enabled !== "true") return { accepted: false, reason: "disabled" };
    if (this.meta.paused === "true") return { accepted: false, reason: "paused" };
    if (this.bytesUsed() > Number(this.meta.quota_bytes)) {
      this.writeMeta("quota_reached_once", true);
      return { accepted: false, reason: "quota_reached" };
    }
    return { accepted: true };
  }

  record({ success = true, capability = null, hostname = null, label = null, errorCode = null, stepIndex = null, chainId = null, sessionId = null }: RecordOptions = {}) {
    const gate = this._ensureEnabled();
    if (!gate.accepted) return { accepted: false, reason: gate.reason };
    const parts = buildSignature({ capability, hostname, label });
    const fingerprint = fingerprintFor(parts);
    const now = isoNow();

    this.db.prepare(
      "INSERT INTO signatures (fingerprint, signature, capability, hostname, verb, label, confirmed_count, failed_count, source_session, first_seen, last_seen) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen",
    ).run(fingerprint, parts.signature, parts.capability, parts.hostname, parts.verb, parts.label, sessionId ?? null, now, now);

    const signature = prepareRows(this.db, "SELECT id FROM signatures WHERE fingerprint = ?", sqlProjection("id")).get(fingerprint);
    if (!signature) return { accepted: false, reason: "storage_unavailable" };

    if (success) {
      this.db.prepare("UPDATE signatures SET confirmed_count = confirmed_count + 1, last_seen = ? WHERE fingerprint = ?").run(now, fingerprint);
    } else {
      this.db.prepare("UPDATE signatures SET failed_count = failed_count + 1, last_seen = ? WHERE fingerprint = ?").run(now, fingerprint);
      const existing = prepareRows(this.db, "SELECT id FROM failure_contexts WHERE signature_id = ? AND error_code = ? AND step_index IS ? AND chain_id IS ? LIMIT 1", sqlProjection("id")).get(signature.id, errorCode ?? "unknown", stepIndex ?? null, chainId ?? null);
      if (existing) {
        this.db.prepare("UPDATE failure_contexts SET count = count + 1, occurred_at = ? WHERE id = ?").run(now, existing.id);
      } else {
        this.db.prepare(
          "INSERT INTO failure_contexts (signature_id, error_code, step_index, chain_id, count, occurred_at) VALUES (?, ?, ?, ?, 1, ?)",
        ).run(signature.id, errorCode ?? "unknown", stepIndex ?? null, chainId ?? null, now);
      }
    }

    if (chainId != null) this._noteChainStep({ chainId, fingerprint, parts, stepIndex: stepIndex ?? null, success, sessionId, now });
    this._queueEmbed(fingerprint, parts.signature);
    this._evictForQuota(Date.now());
    return { accepted: true, fingerprint };
  }

  _noteChainStep({ chainId, fingerprint, parts, stepIndex, success, now }: { chainId: string | number; fingerprint: string; parts: ReturnType<typeof buildSignature>; stepIndex: number | null; success: boolean; sessionId?: string | null; now: string }) {
    const chain = prepareRows(this.db, "SELECT id, steps_json FROM chains WHERE fingerprint = ?", sqlProjection("id", "steps_json")).get(String(chainId));
    if (!chain) return;
    const steps = stepsOf(chain);
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
    if (this.embedQueue) this._queueEmbedChain(String(chainId));
  }

  ensureChain({ chainId, intent = null, sessionId = null }: { chainId: string | number; intent?: string | null; sessionId?: string | null }) {
    const gate = this._ensureEnabled();
    if (!gate.accepted) return { accepted: false, reason: gate.reason };
    const now = isoNow();
    this.db.prepare(
      "INSERT INTO chains (fingerprint, intent, steps_json, source_sessions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET intent = COALESCE(excluded.intent, chains.intent), last_seen = excluded.last_seen",
    ).run(String(chainId), intent ?? null, "[]", sessionId ? JSON.stringify([sessionId]) : null, now, now);
    return { accepted: true, chainId };
  }

  // ---- Action Memory v2: high-level capture -------------------------------

  _v2Gate() {
    const gate = this._ensureEnabled();
    if (!gate.accepted) return false;
    return true;
  }

  _recordUsageEvent({ eventType, actionId = null, chainId = null, success = null, durationMs = null, stepsReused = null, reason = null, profileId = null }: UsageEvent) {
    try {
      const written = this.db.prepare(
        "INSERT INTO memory_usage_events (occurred_at, event_type, action_id, chain_id, success, duration_ms, steps_reused, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(isoNow(), eventType, actionId, chainId, success === null ? null : success ? 1 : 0, durationMs, stepsReused, reason);
      this.profiles.attribute("event", written.lastInsertRowid, profileId);
    } catch (error) {
      throw new Error("Could not persist action usage", { cause: error });
    }
  }

  recordStep(params: RecordStepOptions = {}) { return inTransaction(this.db, () => this._recordStep(params)); }

  _recordStep({ chainId = null, position = null, action = null, hostname = null, target = null, success = true, durationMs = null, errorCode = null, profileId = null }: RecordStepOptions = {}) {
    if (!this._v2Gate()) return { accepted: false, reason: "disabled" };
    const recipe = recipeRecord({ position, action, hostname, target, success });
    if (!recipe) return { accepted: false, reason: "invalid_action" };
    const safeAction = recipe.action;
    const safeHostname = recipe.hostname;
    const now = isoNow();
    const fingerprint = shortFingerprint(JSON.stringify([safeAction, safeHostname, recipe.target_label, recipe.target_role, recipe.selector]));
    this.db.prepare(
      "INSERT INTO memory_actions_v2 (fingerprint, action, hostname, target_label, target_role, recipe_json, confirmed_count, failed_count, first_seen, last_seen) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen, confirmed_count = confirmed_count + ?, failed_count = failed_count + ?",
    ).run(fingerprint, safeAction, safeHostname, recipe.target_label, recipe.target_role, JSON.stringify(recipe), success ? 1 : 0, success ? 0 : 1, now, now, success ? 1 : 0, success ? 0 : 1);

    const row = prepareRows(this.db, "SELECT id FROM memory_actions_v2 WHERE fingerprint = ?", sqlProjection("id")).get(fingerprint);
    const actionId = row?.id ?? null;
    if (actionId) {
      this.profiles.attribute("action", actionId, profileId);
      this._recordUsageEvent({ eventType: "action_recorded", actionId, chainId, success, durationMs, reason: errorCode ?? null, profileId });
      this._queueEmbedV2("action", fingerprint, chainSearchText(safeHostname, [{ action: safeAction, target_role: recipe.target_role, target_label: recipe.target_label }]));
    }
    if (chainId != null && Number.isInteger(position)) this._appendChainStepV2(String(chainId), position, recipe, now);
    return { accepted: true, fingerprint, actionId };
  }

  _appendChainStepV2(chainId: string, position: number | null, recipe: RecipeStep, now: string) {
    const fingerprint = shortFingerprint(`chain:${chainId}`);
    const existing = prepareRows(this.db, "SELECT id, recipe_json FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id", "recipe_json")).get(fingerprint);
    if (!existing) {
      this.db.prepare(
        "INSERT INTO memory_chains_v2 (fingerprint, safe_summary, recipe_json, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
      ).run(fingerprint, "", JSON.stringify([recipe]), now, now);
      return;
    }
    const steps = parseRecipeJson(existing.recipe_json);
    if (steps.length >= MAX_CHAIN_STEPS) return;
    const at = steps.findIndex((step) => step.position === position);
    if (at === -1) steps.push(recipe);
    else steps[at] = recipe;
    steps.sort((first, second) => (first.position ?? 0) - (second.position ?? 0));
    this.db.prepare("UPDATE memory_chains_v2 SET recipe_json = ?, last_seen = ? WHERE id = ?").run(JSON.stringify(steps), now, existing.id);
  }

  finalizeChain(params: FinalizeOptions = {}) { return inTransaction(this.db, () => this._finalizeChain(params)); }

  _finalizeChain({ chainId = null, success = true, durationMs = null, supersedes = null, profileId = null }: FinalizeOptions = {}) {
    if (!this._v2Gate() || chainId == null) return { accepted: false };
    const fingerprint = shortFingerprint(`chain:${chainId}`);
    const chain = prepareRows(this.db, "SELECT id, recipe_json FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id", "recipe_json")).get(fingerprint);
    if (!chain) return { accepted: false };
    const steps = canonicalV2Steps(parseRecipeJson(chain.recipe_json));
    const hostname = steps.find((step) => step.hostname)?.hostname ?? null;
    const summary = chainSearchText(hostname, steps).slice(0, 256);
    const now = isoNow();
    const canonicalFingerprint = chainV2Fingerprint(steps);
    const existing = prepareRows(this.db, "SELECT id FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id")).get(canonicalFingerprint);
    let finalizedId = chain.id;
    if (existing && existing.id !== chain.id) {
      this.db.prepare("UPDATE memory_chains_v2 SET confirmed_count = confirmed_count + ?, failed_count = failed_count + ?, last_seen = ? WHERE id = ?")
        .run(success ? 1 : 0, success ? 0 : 1, now, existing.id);
      this.profiles.inheritChain(existing.id, [chain.id]);
      this.db.prepare("DELETE FROM memory_chains_v2 WHERE id = ?").run(chain.id);
      finalizedId = existing.id;
    } else {
      this.db.prepare("UPDATE memory_chains_v2 SET fingerprint = ?, safe_summary = ?, recipe_json = ?, confirmed_count = confirmed_count + ?, failed_count = failed_count + ?, last_seen = ? WHERE id = ?")
        .run(canonicalFingerprint, summary, JSON.stringify(steps), success ? 1 : 0, success ? 0 : 1, now, chain.id);
    }
    if (success && Number.isInteger(supersedes) && supersedes !== finalizedId) {
      this.db.prepare("UPDATE memory_chains_v2 SET replaced_by = ? WHERE id = ? AND replaced_by IS NULL").run(finalizedId, supersedes);
      this.db.prepare("UPDATE memory_chains_v2 SET supersedes = COALESCE(supersedes, ?) WHERE id = ?").run(supersedes, finalizedId);
    }
    this.profiles.attribute("chain", finalizedId, profileId);
    if (success) finalizedId = this._mergeCompatibleV2Head(finalizedId, now);
    const finalized = prepareRows(this.db, "SELECT fingerprint, safe_summary, recipe_json FROM memory_chains_v2 WHERE id = ?", sqlProjection("fingerprint", "safe_summary", "recipe_json")).get(finalizedId);
    this._queueEmbedV2("chain", finalized?.fingerprint ?? canonicalFingerprint, finalized?.safe_summary ?? summary);
    this.profiles.attribute("chain", finalizedId, profileId);
    this._recordUsageEvent({ eventType: "chain_recorded", chainId: finalizedId, success, durationMs, stepsReused: steps.length, profileId });
    return { accepted: true, chainId: finalizedId, steps: steps.length, summary: finalized?.safe_summary ?? summary };
  }

  _mergeCompatibleV2Head(chainId: number, now: string) {
    const current = prepareRows(this.db, "SELECT id, recipe_json FROM memory_chains_v2 WHERE id = ? AND replaced_by IS NULL", sqlProjection("id", "recipe_json")).get(chainId);
    if (!current) return chainId;
    const currentSteps = canonicalV2Steps(parseRecipeJson(current.recipe_json));
    const hostname = currentSteps[0]?.hostname ?? null;
    if (!hostname) return chainId;
    const candidates = prepareRows(this.db, "SELECT id, recipe_json FROM memory_chains_v2 WHERE id != ? AND replaced_by IS NULL", sqlProjection("id", "recipe_json")).all(chainId);
    for (const candidate of candidates) {
      const candidateSteps = canonicalV2Steps(parseRecipeJson(candidate.recipe_json));
      if (candidateSteps[0]?.hostname !== hostname) continue;
      const merged = mergeV2Overlap(candidateSteps, currentSteps);
      if (!merged || merged.length > MAX_CHAIN_STEPS || merged.length <= Math.max(candidateSteps.length, currentSteps.length)) continue;
      const mergedFingerprint = chainV2Fingerprint(merged);
      const summary = chainSearchText(hostname, merged).slice(0, 256);
      let mergedRow = prepareRows(this.db, "SELECT id, replaced_by FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id", "replaced_by")).get(mergedFingerprint);
      if (mergedRow?.replaced_by != null) continue;
      if (!mergedRow) {
        this.db.prepare("INSERT INTO memory_chains_v2 (fingerprint, safe_summary, recipe_json, confirmed_count, merged_of, first_seen, last_seen) VALUES (?, ?, ?, 1, ?, ?, ?)")
          .run(mergedFingerprint, summary, JSON.stringify(merged), JSON.stringify([candidate.id, current.id]), now, now);
        mergedRow = prepareRows(this.db, "SELECT id, replaced_by FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id", "replaced_by")).requiredGet(mergedFingerprint);
      }
      if (!mergedRow) throw new Error("Merged chain was not persisted");
      this.db.prepare("UPDATE memory_chains_v2 SET replaced_by = ? WHERE id IN (?, ?) AND id != ?").run(mergedRow.id, candidate.id, current.id, mergedRow.id);
      this.db.prepare("UPDATE memory_chains_v2 SET supersedes = COALESCE(supersedes, ?) WHERE id = ?").run(current.id, mergedRow.id);
      this.profiles.inheritChain(mergedRow.id, [candidate.id, current.id]);
      return mergedRow.id;
    }
    return chainId;
  }

  recoverEmbeddings() {
    if (!this.embedQueue?.embed) return;
    const actions = prepareRows(this.db, "SELECT fingerprint, action, hostname, target_label, target_role FROM memory_actions_v2 WHERE embedding IS NULL LIMIT ?", sqlProjection("fingerprint", "action", "hostname", "target_label", "target_role")).all(this.embedQueue.capacity);
    for (const row of actions) this._queueEmbedV2("action", row.fingerprint, chainSearchText(row.hostname, [row]));
    const chains = prepareRows(this.db, "SELECT fingerprint, safe_summary FROM memory_chains_v2 WHERE embedding IS NULL AND replaced_by IS NULL AND safe_summary != '' LIMIT ?", sqlProjection("fingerprint", "safe_summary")).all(Math.max(0, this.embedQueue.capacity - actions.length));
    for (const row of chains) this._queueEmbedV2("chain", row.fingerprint, row.safe_summary);
  }

  _queueEmbedV2(kind: string, fingerprint: string, text: string) {
    if (!this.embedQueue) return;
    this.embedQueue.push({ fingerprint: `v2:${kind}:${fingerprint}`, kind: `v2_${kind}`, text });
  }

  applyEmbeddingV2({ fingerprint, values, modelId = null, dims = null, embeddingProfile = null }: { fingerprint: string; values: ArrayLike<number> | undefined; modelId?: string | null; dims?: number | null; embeddingProfile?: string | null }) {
    if (!values || values.length === 0) return;
    const buffer = embedBufferFromRows([values]);
    const action = prepareRows(this.db, "SELECT id FROM memory_actions_v2 WHERE fingerprint = ?", sqlProjection("id")).get(fingerprint);
    if (action) {
      this.db.prepare("UPDATE memory_actions_v2 SET embedding = ?, embedding_profile = ? WHERE fingerprint = ?").run(buffer, embeddingProfile, fingerprint);
    }
    const chain = prepareRows(this.db, "SELECT id FROM memory_chains_v2 WHERE fingerprint = ?", sqlProjection("id")).get(fingerprint);
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

  noteEmbeddingFailure(error: unknown) {
    this.writeMeta("embedding_failures", Number(this.meta.embedding_failures ?? 0) + 1);
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error ?? "unknown").slice(0, 160);
    this.writeMeta("last_embedding_error", message);
  }

  unindexedCounts() {
    const activeProfile = typeof this.meta.embedding_profile === "string" ? this.meta.embedding_profile : null;
    const actions = activeProfile
      ? prepareRows(this.db, "SELECT COUNT(*) AS n FROM memory_actions_v2 WHERE embedding IS NULL OR embedding_profile IS NOT ?", sqlProjection("n")).requiredGet(activeProfile).n
      : prepareRows(this.db, "SELECT COUNT(*) AS n FROM memory_actions_v2 WHERE embedding IS NULL", sqlProjection("n")).requiredGet().n;
    const chains = activeProfile
      ? prepareRows(this.db, "SELECT COUNT(*) AS n FROM memory_chains_v2 WHERE replaced_by IS NULL AND safe_summary != '' AND (embedding IS NULL OR embedding_profile IS NOT ?)", sqlProjection("n")).requiredGet(activeProfile).n
      : prepareRows(this.db, "SELECT COUNT(*) AS n FROM memory_chains_v2 WHERE replaced_by IS NULL AND safe_summary != '' AND embedding IS NULL", sqlProjection("n")).requiredGet().n;
    return { unindexed_actions: actions, unindexed_chains: chains };
  }

  _queueEmbed(fingerprint: string, text: string) {
    if (!this.embedQueue) return;
    this.embedQueue.push({ fingerprint, kind: "signature", text });
  }

  _queueEmbedChain(_chainId: string) {
    // chain embeddings are composed lazily at search time by composeChainFor/mergeChains
  }

  applyEmbeddings(rows: EmbeddingRow[], modelId: string | null | undefined, dims: number, embeddingProfile: string | null = null) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const legacyStatement = this.db.prepare("UPDATE signatures SET embedding = ?, model_id = ? WHERE fingerprint = ?");
    try {
      inTransaction(this.db, () => {
        if (modelId) this.writeMeta("model_id", modelId);
        if (Number.isInteger(dims)) this.writeMeta("dims", dims);
        if (embeddingProfile) this.writeMeta("embedding_profile", embeddingProfile);
        for (const item of rows) {
          if (!item.values || item.values.length === 0) continue;
          if (typeof item.fingerprint === "string" && item.fingerprint.startsWith("v2:")) {
            const stripped = item.fingerprint.replace(/^v2:(?:action|chain):/, "");
            this.applyEmbeddingV2({ fingerprint: stripped, values: item.values, modelId, dims, embeddingProfile });
            continue;
          }
          legacyStatement.run(embedBufferFromRows([item.values]), modelId ?? null, item.fingerprint);
        }
        this.writeMeta("last_embedding_error", null);
      });
    } catch (error) {
      this.meta = this._readMeta();
      throw error;
    }
  }

  protected abstract _evictForQuota(now?: number, purgeDays?: number): void;
  abstract reindex(options: { embed?: (texts: string[]) => Promise<EmbeddingResult>; batchSize?: number; rebuildV2?: boolean }): Promise<ReindexResult>;
}

export function statSize(file: fs.PathLike) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export async function tryRemoveAsync(filePath: fs.PathLike) {
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
