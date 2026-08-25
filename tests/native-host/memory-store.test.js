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
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-test-"));
}

function fakeEmbedder() {
  return {
    embed: async (texts) => {
      const vectors = texts.map((text) => {
        // Deterministic pseudo-embedding: 16-dim unit-ish vectors, stable per string.
        let seed = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
          seed = Math.imul(seed ^ text.charCodeAt(index), 16777619);
        }
        const values = new Float32Array(16);
        let hash = seed;
        for (let dim = 0; dim < 16; dim += 1) {
          hash = Math.imul(hash ^ (hash >>> 15), 2246822519);
          values[dim] = ((hash >>> 0) / 4294967295) * 2 - 1;
        }
        return Array.from(values);
      });
      return { model: "fixture", dims: 16, vectors };
    },
  };
}

function openMemory(embedder = null) {
  const root = tempRoot();
  let queue = null;
  let store = null;
  if (embedder) {
    queue = new EmbedQueue({ embed: embedder.embed, onResults: null });
    queue.setQueryEmbedder(async (query) => (await embedder.embed([query])).vectors[0]);
  }
  store = new MemoryStore({ root, embedQueue: queue });
  if (queue) queue.onResults = (rows, model, dims) => store.applyEmbeddings(rows, model, dims);
  store.enable();
  return { root, store, queue };
}

test("enable initializes the store and capture accepts records", () => {
  const { store, root } = openMemory();
  assert.equal(store.status().enabled, true);
  const result = store.record({ success: true, capability: "browser.tab.create", hostname: "example.com", label: "Start" });
  assert.equal(result.accepted, true);
  const status = store.status();
  assert.equal(status.counts.signatures, 1);
  assert.equal(status.counts.confirmed_total, 1);
  store.close();
  removeRoot(root);
});

test("success never duplicates: same signature reinforces counters only", () => {
  const { store, root } = openMemory(fakeEmbedder());
  store.record({ success: true, capability: "browser.input.gesture", hostname: "stripe.com", label: "Pay" });
  store.record({ success: true, capability: "browser.input.gesture", hostname: "stripe.com", label: "Pay" });
  store.record({ success: true, capability: "browser.input.gesture", hostname: "stripe.com", label: "Pay" });
  const status = store.status();
  assert.equal(status.counts.signatures, 1);
  assert.equal(status.counts.confirmed_total, 3);
  store.close();
  removeRoot(root);
});

test("failures append negative lessons and dedupe by error code and step", () => {
  const { store, root } = openMemory(fakeEmbedder());
  store.record({ success: false, capability: "browser.cdp.execute", hostname: "accounts.google.com", label: "Login", errorCode: "timeout", stepIndex: 2 });
  store.record({ success: false, capability: "browser.cdp.execute", hostname: "accounts.google.com", label: "Login", errorCode: "timeout", stepIndex: 2 });
  store.record({ success: false, capability: "browser.cdp.execute", hostname: "accounts.google.com", label: "Login", errorCode: "rpc-32603", stepIndex: 2 });
  const status = store.status();
  assert.equal(status.counts.signatures, 1);
  assert.equal(status.counts.failed_total, 3);
  assert.equal(status.counts.failure_contexts, 2);
  const listed = store.list({ limit: 10 });
  assert.equal(listed.events[0].failed_count, 3);
  store.close();
  removeRoot(root);
});

test("query supports filters and bounded slices", () => {
  const { store, root } = openMemory();
  store.record({ success: true, capability: "browser.tab.create", hostname: "a.com", label: "A" });
  store.record({ success: true, capability: "browser.tab.claim", hostname: "b.com", label: "B" });
  const byCapability = store.query({ capability: "browser.tab.claim" });
  assert.equal(byCapability.events.length, 1);
  assert.equal(byCapability.events[0].hostname, "b.com");
  const byHostname = store.query({ hostname: "a.com" });
  assert.equal(byHostname.events.length, 1);
  assert.equal(store.query({ limit: 200 }).events.length, 2);
  store.close();
  removeRoot(root);
});

test("bug: labels never leak as signatures themselves", () => {
  const { store, root } = openMemory();
  store.record({ success: true, capability: "browser.input.gesture", hostname: "x.com", label: "a".repeat(200) + "sensitive-token" });
  const listed = store.list();
  assert.equal(listed.events[0].label.length <= 64, true);
  assert.equal(listed.events[0].signature.includes("sensitive-token"), false);
  store.close();
  removeRoot(root);
});

test("import and export roundtrip merge by fingerprint", () => {
  const { store, root } = openMemory();
  store.record({ success: true, capability: "browser.tab.create", hostname: "x.com", label: "Home" });
  const payload = store.exportJson();
  assert.ok(payload.signatures.length === 1);

  const importedRoot = tempRoot();
  const imported = new MemoryStore({ root: importedRoot });
  imported.enable();
  const result = imported.importJson(payload);
  assert.equal(result.imported, 1);
  const after = imported.status();
  assert.equal(after.counts.signatures, 1);
  assert.equal(after.counts.confirmed_total, 1);
  // merge increments rather than duplicating
  imported.importJson(payload);
  assert.equal(imported.status().counts.confirmed_total, 2);
  assert.equal(imported.status().counts.signatures, 1);
  imported.close();
  store.close();
  removeRoot(root);
  removeRoot(importedRoot);
});

test("configure validates quota, purge days, and power user bounds", () => {
  const { store, root } = openMemory();
  store.configure({ purge_days: 3, power_user: true, quota_bytes: 256 * 1024 * 1024 });
  const status = store.status();
  assert.equal(status.purge_days, 3);
  assert.equal(status.power_user, true);
  assert.equal(status.quota_bytes, 256 * 1024 * 1024);
  assert.throws(() => store.configure({ quota_bytes: 11 * 1024 * 1024 * 1024 }));
  assert.throws(() => store.configure({ purge_days: 0 }));
  store.close();
  removeRoot(root);
});

test("hardDelete removes the database and its WAL", async () => {
  const { root, store } = openMemory();
  store.record({ success: true, capability: "browser.tab.create", hostname: "x.com" });
  await store.hardDelete();
  assert.equal(fs.existsSync(path.join(root, "memory.db")), false);
});