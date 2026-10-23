import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_CHAIN_STEPS } from "./config.ts";
import { prepareRows,sqlProjection } from "./database.ts";
import { embedBufferFromRows,float32FromBuffer } from "./rank.ts";
import type { MemoryStore } from "./store.ts";
const legacyStepSchema = z.looseObject({ position: z.number().optional(), fingerprint: z.string().optional(), capability: z.string().nullable().optional(), hostname: z.string().nullable().optional(), verb: z.string().nullable().optional(), label: z.string().nullable().optional(), success: z.boolean().optional() });
export type LegacyStep = z.infer<typeof legacyStepSchema>;
type CompositionStore = Pick<MemoryStore, "db" | "meta">;

export function stepsOf(chain: { steps_json: string | null }) {
  try {
    const steps = (JSON.parse(chain.steps_json ?? "[]") as unknown);
    return z.array(legacyStepSchema).parse(steps);
  } catch {
    return [];
  }
}

export function chainFingerprint(parts: readonly string[]) {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

export function composeChainEmbedding(store: CompositionStore, chainId: number) {
  const chain = prepareRows(store.db, "SELECT * FROM chains WHERE id = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(chainId);
  if (!chain) return null;
  const steps = stepsOf(chain);
  const embeddings = [];
  for (const step of steps) {
    if (!step.fingerprint) continue;
    const signature = prepareRows(store.db, "SELECT embedding FROM signatures WHERE fingerprint = ?", sqlProjection("embedding")).get(step.fingerprint);
    if (signature?.embedding) embeddings.push(float32FromBuffer(signature.embedding));
  }
  if (embeddings.length === 0) return null;
  const dims = embeddings[0]?.length ?? 0;
  const mean = new Float32Array(dims);
  for (const embedding of embeddings) {
    if (embedding.length !== dims) throw new Error("Inconsistent chain embedding dimensions");
    for (let index = 0; index < dims; index += 1) mean[index] = (mean[index] ?? 0) + (embedding[index] ?? 0) / embeddings.length;
  }
  store.db.prepare("UPDATE chains SET embedding = ?, model_id = ? WHERE id = ?").run(embedBufferFromRows([mean]), typeof store.meta.model_id === "string" ? store.meta.model_id : null, chainId);
  return mean;
}

export function appendOverlap(baseSteps: LegacyStep[], incomingSteps: LegacyStep[]) {
  if (baseSteps.length === 0) return incomingSteps.map((step, index) => ({ ...step, position: index }));
  const baseKeys = baseSteps.map((step) => step.fingerprint).filter((row): row is NonNullable<typeof row> => row !== undefined);
  const incomingKeys = incomingSteps.map((step) => step.fingerprint).filter((row): row is NonNullable<typeof row> => row !== undefined);
  let overlap = 0;
  for (let length = Math.min(baseKeys.length, incomingKeys.length); length > 0; length -= 1) {
    const suffix = baseKeys.slice(baseKeys.length - length).join(",");
    const prefix = incomingKeys.slice(0, length).join(",");
    if (suffix === prefix) {
      overlap = length;
      break;
    }
  }
  const merged = [...baseSteps];
  for (const step of incomingSteps.slice(overlap)) {
    merged.push({ ...step, position: merged.length });
  }
  return merged;
}

export function mergeChains(store: CompositionStore, { baseFingerprint, incomingFingerprint, intent = null }: { baseFingerprint: string; incomingFingerprint: string; intent?: string | null }) {
  const base = prepareRows(store.db, "SELECT * FROM chains WHERE fingerprint = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(baseFingerprint);
  const incoming = prepareRows(store.db, "SELECT * FROM chains WHERE fingerprint = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(incomingFingerprint);
  if (!base || !incoming) return { ok: false, reason: "missing_chain" };
  const mergedSteps = appendOverlap(stepsOf(base), stepsOf(incoming));
  if (mergedSteps.length > MAX_CHAIN_STEPS) {
    return { ok: false, reason: "too_long" };
  }
  const fingerprint = chainFingerprint([mergedSteps.map((step) => step.fingerprint ?? "").join("|"), baseFingerprint, incomingFingerprint]);
  const now = new Date().toISOString();
  store.db.prepare(
    "INSERT INTO chains (fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, merged_of, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(fingerprint) DO UPDATE SET intent = COALESCE(excluded.intent, chains.intent), confirmed_count = chains.confirmed_count + excluded.confirmed_count",
  ).run(
    fingerprint,
    intent ?? base.intent ?? incoming.intent ?? null,
    JSON.stringify(mergedSteps),
    base.confirmed_count + incoming.confirmed_count,
    base.failed_count + incoming.failed_count,
    null,
    JSON.stringify([baseFingerprint, incomingFingerprint]),
    base.first_seen ?? now,
    now,
  );
  const mergedId = prepareRows(store.db, "SELECT id FROM chains WHERE fingerprint = ?", sqlProjection("id")).requiredGet(fingerprint).id;
  store.db.prepare("UPDATE chains SET replaced_by = ? WHERE fingerprint = ?").run(mergedId, baseFingerprint);
  store.db.prepare("UPDATE chains SET replaced_by = ? WHERE fingerprint = ?").run(mergedId, incomingFingerprint);
  store.db.prepare("UPDATE chains SET supersedes = ? WHERE id = ?").run(base.id, mergedId);
  store.db.prepare("UPDATE chains SET supersedes = ? WHERE id = ?").run(incoming.id, mergedId);
  composeChainEmbedding(store, mergedId);
  return { ok: true, chainId: mergedId, fingerprint, merged_of: [baseFingerprint, incomingFingerprint], steps: mergedSteps };
}

export function correctChainStep(store: CompositionStore, { chainFingerprint: chainIdOrFingerprint, position, replacementSignatureFingerprint }: { chainFingerprint: string; position: number; replacementSignatureFingerprint: string }) {
  const chain = prepareRows(store.db, "SELECT * FROM chains WHERE fingerprint = ?", sqlProjection("id", "fingerprint", "intent", "embedding", "model_id", "steps_json", "confirmed_count", "failed_count", "source_sessions", "merged_of", "replaced_by", "supersedes", "first_seen", "last_seen")).get(chainIdOrFingerprint);
  if (!chain) return { ok: false, reason: "missing_chain" };
  const steps = stepsOf(chain);
  const target = steps.find((step) => step.position === position);
  if (!target) return { ok: false, reason: "missing_step" };
  if (target.fingerprint === replacementSignatureFingerprint) return { ok: false, reason: "unchanged" };
  const replacement = prepareRows(store.db, "SELECT fingerprint, capability, hostname, verb, label FROM signatures WHERE fingerprint = ? AND confirmed_count > 0", sqlProjection("fingerprint", "capability", "hostname", "verb", "label")).get(replacementSignatureFingerprint);
  if (!replacement) return { ok: false, reason: "replacement_not_confirmed" };

  const corrected = steps.map((step) => {
    if (step.position !== position) return step;
    return {
      position: step.position,
      fingerprint: replacement.fingerprint,
      capability: replacement.capability,
      hostname: replacement.hostname,
      verb: replacement.verb,
      label: replacement.label,
      success: true,
      replaced_of: target.fingerprint,
    };
  });
  const fingerprint = chainFingerprint([corrected.map((step) => step.fingerprint ?? "").join("|"), String(position), replacementSignatureFingerprint]);
  const now = new Date().toISOString();
  store.db.prepare(
    "INSERT INTO chains (fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, merged_of, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(fingerprint) DO UPDATE SET confirmed_count = chains.confirmed_count + excluded.confirmed_count",
  ).run(
    fingerprint,
    chain.intent,
    JSON.stringify(corrected),
    Math.max(0, chain.confirmed_count - 0),
    chain.failed_count,
    null,
    chain.merged_of,
    chain.first_seen ?? now,
    now,
  );
  const nextId = prepareRows(store.db, "SELECT id FROM chains WHERE fingerprint = ?", sqlProjection("id")).requiredGet(fingerprint).id;
  store.db.prepare("UPDATE chains SET replaced_by = ?, supersedes = ? WHERE id = ?").run(nextId, chain.id, chain.id);
  composeChainEmbedding(store, nextId);
  return { ok: true, chainId: nextId, fingerprint, replaced: target.fingerprint, by: replacementSignatureFingerprint, steps: corrected };
}

export function composeChainFor(store: CompositionStore, { intent = null, sessionId = null, seedSignatures = [], limit = MAX_CHAIN_STEPS }: { intent?: string | null; sessionId?: string | null; seedSignatures?: string[]; limit?: number } = {}) {
  const candidates = Array.isArray(seedSignatures) ? seedSignatures.slice(0, 16) : [];
  if (candidates.length === 0) return { ok: false, reason: "no_candidates" };
  const rows = candidates
    .map((fingerprint) => prepareRows(store.db, "SELECT fingerprint, capability, hostname, verb, label, confirmed_count, failed_count, last_seen FROM signatures WHERE fingerprint = ? AND confirmed_count > 0", sqlProjection("fingerprint", "capability", "hostname", "verb", "label", "confirmed_count", "failed_count", "last_seen")).get(fingerprint))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .sort((a, b) => b.confirmed_count - a.confirmed_count || b.last_seen.localeCompare(a.last_seen));
  const steps = rows.slice(0, limit).map((row, index) => ({
    position: index,
    fingerprint: row.fingerprint,
    capability: row.capability,
    hostname: row.hostname,
    verb: row.verb,
    label: row.label,
    success: true,
  }));
  if (steps.length === 0) return { ok: false, reason: "no_confirmed" };
  const fingerprint = chainFingerprint([steps.map((step) => step.fingerprint ?? "").join("|")]);
  const existing = prepareRows(store.db, "SELECT id FROM chains WHERE fingerprint = ?", sqlProjection("id")).get(fingerprint);
  if (existing) return { ok: true, chainId: existing.id, fingerprint, steps, existing: true };
  const now = new Date().toISOString();
  store.db.prepare(
    "INSERT INTO chains (fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(fingerprint, intent ?? null, JSON.stringify(steps), 0, 0, sessionId ? JSON.stringify([sessionId]) : null, now, now);
  const chainId = prepareRows(store.db, "SELECT id FROM chains WHERE fingerprint = ?", sqlProjection("id")).requiredGet(fingerprint).id;
  composeChainEmbedding(store, chainId);
  return { ok: true, chainId, fingerprint, steps };
}