import { createHash } from "node:crypto";
import { MAX_CHAIN_STEPS } from "./config.js";
import { float32FromBuffer, embedBufferFromRows } from "./rank.js";

export function stepsOf(chain) {
  try {
    const steps = JSON.parse(chain.steps_json ?? "[]");
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

export function chainFingerprint(parts) {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

export function composeChainEmbedding(store, chainId) {
  const chain = store.db.prepare("SELECT * FROM chains WHERE id = ?").get(chainId);
  if (!chain) return null;
  const steps = stepsOf(chain);
  const embeddings = [];
  for (const step of steps) {
    if (!step.fingerprint) continue;
    const signature = store.db.prepare("SELECT embedding FROM signatures WHERE fingerprint = ?").get(step.fingerprint);
    if (signature?.embedding) embeddings.push(float32FromBuffer(signature.embedding));
  }
  if (embeddings.length === 0) return null;
  const dims = embeddings[0].length;
  const mean = new Float32Array(dims);
  for (const embedding of embeddings) {
    for (let index = 0; index < dims; index += 1) mean[index] += embedding[index] / embeddings.length;
  }
  store.db.prepare("UPDATE chains SET embedding = ?, model_id = ? WHERE id = ?").run(embedBufferFromRows([mean]), store.meta.model_id ?? null, chainId);
  return mean;
}

export function appendOverlap(baseSteps, incomingSteps) {
  if (baseSteps.length === 0) return incomingSteps.map((step, index) => ({ ...step, position: index }));
  const baseKeys = baseSteps.map((step) => step.fingerprint).filter(Boolean);
  const incomingKeys = incomingSteps.map((step) => step.fingerprint).filter(Boolean);
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

export function mergeChains(store, { baseFingerprint, incomingFingerprint, intent = null }) {
  const base = store.db.prepare("SELECT * FROM chains WHERE fingerprint = ?").get(baseFingerprint);
  const incoming = store.db.prepare("SELECT * FROM chains WHERE fingerprint = ?").get(incomingFingerprint);
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
  const mergedId = store.db.prepare("SELECT id FROM chains WHERE fingerprint = ?").get(fingerprint).id;
  store.db.prepare("UPDATE chains SET replaced_by = ? WHERE fingerprint = ?").run(mergedId, baseFingerprint);
  store.db.prepare("UPDATE chains SET replaced_by = ? WHERE fingerprint = ?").run(mergedId, incomingFingerprint);
  store.db.prepare("UPDATE chains SET supersedes = ? WHERE id = ?").run(base.id, mergedId);
  store.db.prepare("UPDATE chains SET supersedes = ? WHERE id = ?").run(incoming.id, mergedId);
  composeChainEmbedding(store, mergedId);
  return { ok: true, chainId: mergedId, fingerprint, merged_of: [baseFingerprint, incomingFingerprint], steps: mergedSteps };
}

export function correctChainStep(store, { chainFingerprint: chainIdOrFingerprint, position, replacementSignatureFingerprint }) {
  const chain = store.db.prepare("SELECT * FROM chains WHERE fingerprint = ?").get(chainIdOrFingerprint);
  if (!chain) return { ok: false, reason: "missing_chain" };
  const steps = stepsOf(chain);
  const target = steps.find((step) => step.position === position);
  if (!target) return { ok: false, reason: "missing_step" };
  if (target.fingerprint === replacementSignatureFingerprint) return { ok: false, reason: "unchanged" };
  const replacement = store.db.prepare(
    "SELECT fingerprint, capability, hostname, verb, label FROM signatures WHERE fingerprint = ? AND confirmed_count > 0",
  ).get(replacementSignatureFingerprint);
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
  const nextId = store.db.prepare("SELECT id FROM chains WHERE fingerprint = ?").get(fingerprint).id;
  store.db.prepare("UPDATE chains SET replaced_by = ?, supersedes = ? WHERE id = ?").run(nextId, chain.id, chain.id);
  composeChainEmbedding(store, nextId);
  return { ok: true, chainId: nextId, fingerprint, replaced: target.fingerprint, by: replacementSignatureFingerprint, steps: corrected };
}

export function composeChainFor(store, { intent = null, sessionId = null, seedSignatures = [], limit = MAX_CHAIN_STEPS } = {}) {
  const candidates = Array.isArray(seedSignatures) ? seedSignatures.slice(0, 16) : [];
  if (candidates.length === 0) return { ok: false, reason: "no_candidates" };
  const rows = candidates
    .map((fingerprint) => store.db.prepare("SELECT fingerprint, capability, hostname, verb, label, confirmed_count, failed_count, last_seen FROM signatures WHERE fingerprint = ? AND confirmed_count > 0").get(fingerprint))
    .filter(Boolean)
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
  const existing = store.db.prepare("SELECT id FROM chains WHERE fingerprint = ?").get(fingerprint);
  if (existing) return { ok: true, chainId: existing.id, fingerprint, steps, existing: true };
  const now = new Date().toISOString();
  store.db.prepare(
    "INSERT INTO chains (fingerprint, intent, steps_json, confirmed_count, failed_count, source_sessions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(fingerprint, intent ?? null, JSON.stringify(steps), 0, 0, sessionId ? JSON.stringify([sessionId]) : null, now, now);
  const chainId = store.db.prepare("SELECT id FROM chains WHERE fingerprint = ?").get(fingerprint).id;
  composeChainEmbedding(store, chainId);
  return { ok: true, chainId, fingerprint, steps };
}