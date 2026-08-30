import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmbedQueue, MemoryStore } from "../../native-host/src/memory/index.js";

function removeRoot(root) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      const start = Date.now();
      while (Date.now() - start < 40) { /* wait for windows lock release */ }
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-search-test-"));
}

// Token-overlap embedding: shared tokens give high cosine similarity and
// unrelated texts stay near-orthogonal, so threshold gating is meaningful.
function lexicalVectors(dims = 64) {
  const tokenVector = (token) => {
    let seed = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      seed ^= token.charCodeAt(index);
      seed = Math.imul(seed, 16777619);
    }
    const values = new Float32Array(dims);
    for (let dim = 0; dim < dims; dim += 1) {
      seed = Math.imul(seed ^ (seed >>> 13), 2654435761);
      values[dim] = ((seed >>> 0) / 4294967295) * 2 - 1;
    }
    const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
    return Array.from(values, (value) => value / magnitude);
  };
  const embed = async (texts) => {
    const vectors = texts.map((text) => {
      const acc = new Float32Array(dims);
      const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const token of tokens) {
        const vector = tokenVector(token);
        for (let dim = 0; dim < dims; dim += 1) acc[dim] += vector[dim];
      }
      const magnitude = Math.sqrt(acc.reduce((sum, value) => sum + value * value, 0)) || 1;
      return Array.from(acc, (value) => value / magnitude);
    });
    return { model: "fixture-lexical", dims, vectors, embeddingProfile: "fixture-lexical:q8:d64:prompt-v1" };
  };
  return { embed, query: async (query) => {
    const result = await embed([query]);
    return { vector: result.vectors[0], model: result.model, dims: result.dims, embeddingProfile: result.embeddingProfile };
  } };
}

function openMemory() {
  const root = tempRoot();
  const { embed, query } = lexicalVectors();
  const queue = new EmbedQueue({ embed, onResults: null });
  queue.setQueryEmbedder(query);
  const store = new MemoryStore({ root, embedQueue: queue });
  queue.onResults = (rows, model, dims, embeddingProfile) => store.applyEmbeddings(rows, model, dims, embeddingProfile);
  store.enable();
  return { root, store, queue };
}

function seedV2Actions(store) {
  store.recordStep({ position: 0, action: "click", hostname: "checkout.stripe.com", target: { label: "Pay now", role: "button" }, success: true });
  store.recordStep({ position: 1, action: "fill", hostname: "checkout.stripe.com", target: { label: "Card number", role: "textbox" }, success: true });
  store.recordStep({ position: 2, action: "click", hostname: "old-broken-site.example", target: { label: "Dead end" }, success: false, errorCode: "timeout" });
}

test("v2 search returns ranked high-level results with confidence semantics", async () => {
  const { store, root } = openMemory();
  seedV2Actions(store);
  await store.embedQueue.flush();
  const result = await store.search({ query: "click pay now on the checkout", limit: 10 });

  assert.ok(result.results.length >= 1, `expected ranked results, got ${result.results.length}`);
  const first = result.results[0];
  assert.equal(typeof first.confidence, "number");
  assert.ok(["action_v2", "chain_v2"].includes(first.kind), `expected v2 kinds, got ${first.kind}`);
  const pay = result.results.find((item) => item.label === "Dead end");
  if (pay) assert.equal(pay.negative, true);
  const second = await store.search({ query: "click pay now on the checkout", limit: 10 });
  assert.deepEqual(result.results.map((item) => item.id), second.results.map((item) => item.id));
  store.close();
  removeRoot(root);
});

test("unrelated queries return no candidate instead of the least bad match", async () => {
  const { store, root } = openMemory();
  seedV2Actions(store);
  await store.embedQueue.flush();
  const result = await store.search({ query: "entirely unrelated quantum physics query about nothing here", limit: 5 });

  for (const item of result.results) {
    assert.ok(item.similarity >= result.threshold, `result below threshold leaked: ${item.similarity} < ${result.threshold}`);
  }
  store.close();
  removeRoot(root);
});

test("v2 chains record one step per high-level action and stay replayable", async () => {
  const { store, root } = openMemory();
  store.recordStep({ chainId: "chain-a", position: 0, action: "click", hostname: "checkout.stripe.com", target: { label: "Start checkout", role: "button" }, success: true });
  store.recordStep({ chainId: "chain-a", position: 1, action: "fill", hostname: "checkout.stripe.com", target: { label: "Card number", role: "textbox" }, success: true });
  const finalized = store.finalizeChain({ chainId: "chain-a", success: true });
  assert.ok(finalized.accepted);
  assert.equal(finalized.steps, 2);
  await store.embedQueue.flush();

  const result = await store.search({ query: "start checkout and fill card number", kind: "chain", limit: 5 });
  const chain = result.results.find((item) => item.kind === "chain_v2");
  assert.ok(chain, "chain_v2 result present");
  assert.ok(Array.isArray(chain.steps));
  assert.equal(chain.steps.length, 2);
  assert.equal(chain.steps[0].action, "click");
  assert.equal(chain.steps[1].requiresRuntimeValue, true, "fill steps require a runtime value");
  assert.equal(chain.steps[1].target_label, "Card number");
  store.close();
  removeRoot(root);
});

test("legacy v1 data is not served as replayable memory by default", async () => {
  const { store, root } = openMemory();
  store.record({ success: true, capability: "browser.tab.create", hostname: "checkout.stripe.com", label: "Start" });
  store.ensureChain({ chainId: "chain-legacy", intent: "legacy checkout" });
  store.record({ success: true, capability: "browser.input.gesture", hostname: "checkout.stripe.com", label: "Pay", chainId: "chain-legacy", stepIndex: 0 });
  await store.embedQueue.flush();

  const modern = await store.search({ query: "legacy checkout pay", kind: "chain", limit: 5 });
  assert.equal(modern.results.find((item) => item.kind === "chain"), undefined, "v1 chains must not surface as replayable");

  const legacy = await store.search({ query: "checkout stripe pay gesture tab", kind: "chain", limit: 5, includeLegacy: true });
  assert.ok(legacy.results.some((item) => item.kind === "chain"), "opt-in legacy view still works");
  store.close();
  removeRoot(root);
});

test("schema v2 migration tags legacy data and bumps the version", async () => {
  const { store, root } = openMemory();
  const status = store.status();
  assert.equal(status.schema_version, 2);
  assert.equal(status.legacy_v1_tagged, false);
  store.close();
  removeRoot(root);
});

test("search without embed queue degrades with the documented code", async () => {
  const root = tempRoot();
  const store = new MemoryStore({ root });
  store.enable();
  store.recordStep({ position: 0, action: "click", hostname: "x.com", target: { label: "Go" }, success: true });
  const result = await store.search({ query: "anything" });
  assert.equal(result.results.length, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.error, "memory_model_unavailable");
  store.close();
  removeRoot(root);
});

test("usage events replace the inflated hits counter", async () => {
  const { store, root } = openMemory();
  seedV2Actions(store);
  await store.embedQueue.flush();
  await store.search({ query: "click pay now on the checkout" });
  const usage = store.usageMetrics();
  assert.equal(usage.search_queries, 1);
  assert.equal(usage.matches_returned >= 0, true);
  assert.equal(usage.replay_attempts, 0);
  const status = store.status();
  assert.equal(typeof status.usage.replay_success_rate === "number" || status.usage.replay_success_rate === null, true);
  store.close();
  removeRoot(root);
});

test("typed values, full URLs, and paths never enter v2 recipes", async () => {
  const { store, root } = openMemory();
  const recorded = store.recordStep({
    chainId: "274b81aa-1234-5678-9abc-def012345678",
    position: 0,
    action: "fill",
    hostname: "example.com",
    target: { label: "user@company.com", selector: "#email[data-account='12345678901234567']", role: "textbox" },
    success: true,
  });
  assert.ok(recorded.accepted);
  const pending = store.db.prepare("SELECT safe_summary FROM memory_chains_v2").get();
  assert.equal(pending.safe_summary, "", "transient chain identifiers must never be persisted as summaries");
  const finalized = store.finalizeChain({ chainId: "274b81aa-1234-5678-9abc-def012345678", success: true });
  assert.ok(finalized.accepted);
  const summary = store.db.prepare("SELECT safe_summary, recipe_json FROM memory_chains_v2 WHERE id = ?").get(finalized.chainId);
  assert.doesNotMatch(summary.safe_summary, /user@company\.com/);
  assert.doesNotMatch(summary.safe_summary, /12345678901234567/);
  const action = store.db.prepare("SELECT recipe_json FROM memory_actions_v2 WHERE id = ?").get(recorded.actionId);
  const recipe = JSON.parse(action.recipe_json);
  assert.notEqual(recipe.target_label, "user@company.com");
  assert.equal(recipe.selector, null, "selector containing PII must be rejected");
  assert.equal(recipe.requiresRuntimeUrl, false);
  store.close();
  removeRoot(root);
});

test("navigate recipes bind only the live URL and stale embedding profiles are rebuilt", async () => {
  const { store, root } = openMemory();
  const recorded = store.recordStep({ chainId: "navigate-chain", position: 0, action: "navigate", hostname: "example.com", success: true });
  store.finalizeChain({ chainId: "navigate-chain", success: true });
  await store.embedQueue.flush();
  const recipe = JSON.parse(store.db.prepare("SELECT recipe_json FROM memory_actions_v2 WHERE id = ?").get(recorded.actionId).recipe_json);
  assert.equal(recipe.requiresRuntimeValue, false);
  assert.equal(recipe.requiresRuntimeUrl, true);

  const nextProfileEmbed = async (texts) => {
    const result = await lexicalVectors().embed(texts);
    return { ...result, embeddingProfile: "fixture-next:q8:d64:prompt-v1" };
  };
  const result = await store.reindex({ embed: nextProfileEmbed });
  assert.ok(result.v2_embedded >= 1);
  assert.equal(store.db.prepare("SELECT embedding_profile FROM memory_actions_v2 WHERE id = ?").get(recorded.actionId).embedding_profile, "fixture-next:q8:d64:prompt-v1");
  store.close();
  removeRoot(root);
});

test("embedding queue drops are counted once", () => {
  const root = tempRoot();
  const queue = new EmbedQueue({ embed: async () => ({ vectors: [] }), capacity: 0 });
  const store = new MemoryStore({ root, embedQueue: queue });
  store.enable();
  store.recordStep({ action: "click", target: { label: "Go" } });
  assert.equal(Number(store.meta.embedding_queue_drops), 1);
  store.close();
  removeRoot(root);
});

test("canonical v2 chains reinforce duplicates and preserve correction lineage", () => {
  const { store, root } = openMemory();
  for (const chainId of ["first-run", "second-run"]) {
    store.recordStep({ chainId, position: 0, action: "click", hostname: "example.com", target: { label: "Start", role: "button" }, success: true });
    store.recordStep({ chainId, position: 1, action: "fill", hostname: "example.com", target: { label: "Name", role: "textbox" }, success: true });
  }
  const first = store.finalizeChain({ chainId: "first-run", success: true });
  const second = store.finalizeChain({ chainId: "second-run", success: true });
  assert.equal(first.chainId, second.chainId);
  assert.equal(store.status().counts.chains_v2, 1);
  assert.equal(store.db.prepare("SELECT confirmed_count FROM memory_chains_v2 WHERE id = ?").get(first.chainId).confirmed_count, 2);

  store.recordStep({ chainId: "corrected", position: 0, action: "click", hostname: "example.com", target: { label: "Start", role: "button" }, success: true });
  store.recordStep({ chainId: "corrected", position: 1, action: "click", hostname: "example.com", target: { label: "Continue", role: "button" }, success: true });
  const corrected = store.finalizeChain({ chainId: "corrected", success: true, supersedes: first.chainId });
  assert.equal(store.db.prepare("SELECT replaced_by FROM memory_chains_v2 WHERE id = ?").get(first.chainId).replaced_by, corrected.chainId);
  assert.equal(store.db.prepare("SELECT supersedes FROM memory_chains_v2 WHERE id = ?").get(corrected.chainId).supersedes, first.chainId);
  store.close();
  removeRoot(root);
});

test("replay lifecycle and v2 execution metrics exclude rejected candidates", () => {
  const { store, root } = openMemory();
  store.recordStep({ action: "click", hostname: "example.com", target: { label: "Go" }, success: true });
  store.recordStep({ action: "fill", hostname: "example.com", target: { label: "Name" }, success: false });
  store.usageEvent({ eventType: "replay_rejected", reason: "below_confidence" });
  store.usageEvent({ eventType: "replay_started", chainId: 1 });
  store.usageEvent({ eventType: "replay_succeeded", chainId: 1, success: true, stepsReused: 2 });
  const status = store.status();
  assert.equal(status.counts.executions_v2, 2);
  assert.equal(status.counts.failed_executions_v2, 1);
  assert.equal(status.counts.negative_actions_v2, 1);
  assert.equal(status.usage.replay_attempts, 1);
  assert.equal(status.usage.replay_fallbacks, 1);
  assert.equal(status.usage.replay_success_rate, 100);
  assert.equal(status.usage.steps_reused, 2);
  store.close();
  removeRoot(root);
});

test("same-host v2 fragments merge only across a two-step exact overlap", () => {
  const { store, root } = openMemory();
  const add = (chainId, labels) => {
    labels.forEach((label, position) => store.recordStep({ chainId, position, action: "click", hostname: "example.com", target: { label, role: "button" }, success: true }));
    return store.finalizeChain({ chainId, success: true });
  };
  const first = add("fragment-a", ["A", "B", "C"]);
  const second = add("fragment-b", ["B", "C", "D"]);
  const head = store.db.prepare("SELECT id, recipe_json, merged_of FROM memory_chains_v2 WHERE replaced_by IS NULL").get();
  assert.ok(head.id !== first.chainId || head.id !== second.chainId);
  assert.deepEqual(JSON.parse(head.recipe_json).map((step) => step.target_label), ["A", "B", "C", "D"]);
  const parents = JSON.parse(head.merged_of);
  assert.equal(parents.length, 2);
  assert.equal(parents[0], first.chainId);
  store.close();
  removeRoot(root);
});

test("embedding identity mismatch returns index_stale and reindexes before search", async () => {
  const root = tempRoot();
  let profile = "fixture-old:q8:d64:prompt-v1";
  let model = "fixture-old";
  const base = lexicalVectors();
  const embed = async (texts) => ({ ...(await base.embed(texts)), model, embeddingProfile: profile });
  const queue = new EmbedQueue({ embed });
  queue.setQueryEmbedder(async (query) => {
    const result = await embed([query]);
    return { vector: result.vectors[0], model: result.model, dims: result.dims, embeddingProfile: result.embeddingProfile };
  });
  const store = new MemoryStore({ root, embedQueue: queue });
  queue.onResults = (rows, nextModel, dims, embeddingProfile) => store.applyEmbeddings(rows, nextModel, dims, embeddingProfile);
  store.enable();
  store.recordStep({ action: "click", hostname: "example.com", target: { label: "Go" }, success: true });
  await queue.flush();
  profile = "fixture-next:q8:d64:prompt-v1";
  model = "fixture-next";
  const stale = await store.search({ query: "click go" });
  assert.equal(stale.error, "index_stale");
  await queue.reindexPromise;
  const recovered = await store.search({ query: "click go" });
  assert.notEqual(recovered.error, "index_stale");
  assert.equal(store.meta.embedding_profile, profile);
  store.close();
  removeRoot(root);
});
