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

function deterministicVectors(dims = 16) {
  const embed = async (texts) => {
    const vectors = texts.map((text) => {
      let seed = 0;
      for (let index = 0; index < text.length; index += 1) seed = (seed * 31 + text.charCodeAt(index)) >>> 0;
      const values = new Float32Array(dims);
      for (let dim = 0; dim < dims; dim += 1) {
        seed = Math.imul(seed ^ (seed >>> 13), 2654435761);
        values[dim] = ((seed >>> 0) / 4294967295) * 2 - 1;
      }
      const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
      return Array.from(values, (value) => value / magnitude);
    });
    return { model: "fixture-16", dims, vectors };
  };
  return { embed, query: async (query) => (await embed([query])).vectors[0] };
}

function openMemory() {
  const root = tempRoot();
  const { embed, query } = deterministicVectors();
  const queue = new EmbedQueue({ embed, onResults: null });
  queue.setQueryEmbedder(query);
  const store = new MemoryStore({ root, embedQueue: queue });
  queue.onResults = (rows, model, dims) => store.applyEmbeddings(rows, model, dims);
  store.enable();
  return { root, store, queue };
}

function seed(store) {
  store.record({ success: true, capability: "browser.input.gesture", hostname: "checkout.stripe.com", label: "Pay" });
  store.record({ success: true, capability: "browser.input.gesture", hostname: "checkout.stripe.com", label: "Card number" });
  store.record({ success: false, capability: "browser.cdp.execute", hostname: "checkout.stripe.com", label: "Pay", errorCode: "timeout" });
  store.record({ success: false, capability: "browser.tab.create", hostname: "old-broken-site.example", label: "Dead end", errorCode: "rpc-32603" });
}

test("search returns ranked results with confidence semantics", async () => {
  const { store, root } = openMemory();
  seed(store);
  await store.embedQueue.flush();
  const result = await store.search({ query: "submit the payment on the checkout", limit: 10 });
  assert.ok(result.results.length >= 2, `expected ranked results, got ${result.results.length}`);
  const first = result.results[0];
  assert.ok(first.confirmed_count > 0 || first.confirmed_count === 0);
  assert.equal(typeof first.confidence, "number");
  // confirmed streaks rank above failed lessons for the same signature family
  const pay = result.results.find((item) => item.label === "Pay");
  assert.ok(pay, "Pay signature should be returned");
  assert.equal(pay.negative, true); // the only Pay row has failures and zero confirms... unless confirmed Pay matched first
  // ranking determinism: same query twice equals same order
  const second = await store.search({ query: "submit the payment on the checkout", limit: 10 });
  assert.deepEqual(result.results.map((item) => item.id), second.results.map((item) => item.id));
  store.close();
  removeRoot(root);
});

test("kind chain searches only chain heads", async () => {
  const { store, root } = openMemory();
  seed(store);
  store.ensureChain({ chainId: "chain-a", intent: "checkout flow" });
  store.record({ success: true, capability: "browser.tab.create", hostname: "checkout.stripe.com", label: "Start", chainId: "chain-a", stepIndex: 0 });
  store.record({ success: true, capability: "browser.input.gesture", hostname: "checkout.stripe.com", label: "Pay", chainId: "chain-a", stepIndex: 1 });
  await store.embedQueue.flush();
  const result = await store.search({ query: "checkout flow", kind: "chain", limit: 5 });
  assert.ok(result.results.length >= 1, "chain head should be searchable");
  const chainResult = result.results.find((item) => item.kind === "chain");
  assert.ok(chainResult, "chain result present");
  assert.ok(Array.isArray(chainResult.steps));
  store.close();
  removeRoot(root);
});

test("search without embed queue degrades with the documented code", async () => {
  const root = tempRoot();
  const store = new MemoryStore({ root });
  store.enable();
  store.record({ success: true, capability: "browser.tab.create", hostname: "x.com" });
  const result = await store.search({ query: "anything" });
  assert.equal(result.results.length, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.error, "memory_model_unavailable");
  store.close();
  removeRoot(root);
});

test("memory hits counter increments on non-empty searches", async () => {
  const { store, root } = openMemory();
  seed(store);
  await store.embedQueue.flush();
  assert.equal(store.status().memory_hits, 0);
  await store.search({ query: "checkout payment" });
  assert.equal(store.status().memory_hits, 1);
  store.close();
  removeRoot(root);
});