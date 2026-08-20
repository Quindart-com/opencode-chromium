import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore, negativeValue, chainLengthWeight, recencyWeight, negligibleThreshold } from "../../native-host/src/memory/index.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-purge-test-"));
}

function openMemory() {
  const root = tempRoot();
  const store = new MemoryStore({ root });
  store.enable();
  return { root, store };
}

function recordFailure(store, { capability = "browser.cdp.execute", hostname = "x.com", label = "Act", errorCode = "timeout", stepIndex = null, daysAgo = 0, hitsAgo = null } = {}) {
  const now = Date.now();
  const occurred = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  store.record({ success: false, capability, hostname, label, errorCode, stepIndex });
  if (daysAgo > 0 || hitsAgo != null) {
    const context = store.db.prepare("SELECT id, signature_id FROM failure_contexts ORDER BY id DESC LIMIT 1").get();
    if (!context) return; // eviction already reclaimed this lesson under quota pressure
    const hitAt = hitsAgo != null ? new Date(now - hitsAgo * 24 * 60 * 60 * 1000).toISOString() : null;
    store.db.prepare("UPDATE failure_contexts SET occurred_at = ?, last_hit_at = ? WHERE id = ?").run(occurred, hitAt, context.id);
  }
}

test("scoring function rewards long chains and penalizes age", () => {
  assert.equal(chainLengthWeight(0), 1 + Math.log2(1));
  assert.ok(chainLengthWeight(8) > chainLengthWeight(1), "longer negative chains are more valuable");
  assert.ok(recencyWeight(1, 7) > recencyWeight(6, 7), "recent lessons outrank stale ones");
  assert.ok(negativeValue({ chainLength: 5, ageDays: 1, purgeDays: 7 }) > negativeValue({ chainLength: 1, ageDays: 7, purgeDays: 7 }));
  assert.ok(negligibleThreshold(7) > 0);
});

test("aged negatives are removed; confirmed signatures keep only their stale contexts", () => {
  const { store, root } = openMemory();
  recordFailure(store, { hostname: "stale.example", label: "Old", errorCode: "timeout", daysAgo: 30 });
  store.record({ success: true, capability: "browser.tab.create", hostname: "kept.example", label: "Kept" });
  recordFailure(store, { hostname: "kept.example", label: "Kept", errorCode: "timeout", daysAgo: 30 });
  const before = store.status();
  assert.ok(before.counts.failure_contexts >= 2);
  store.prune({ days: 7 });
  const after = store.status();
  assert.equal(after.counts.failure_contexts, 0);
  assert.equal(after.counts.signatures, 1, "purely negative signature is dropped, confirmed one stays");
  assert.equal(after.counts.confirmed_total, 1);
  assert.equal(after.counts.failed_total, 0, "confirmed signature's failed counter recomputed from remaining contexts");
  store.close();
  removeRoot(root);
});

test("recently hit negative lessons survive the age purge", () => {
  const { store, root } = openMemory();
  recordFailure(store, { hostname: "hit.example", label: "Recently hit", errorCode: "timeout", daysAgo: 30, hitsAgo: 2 });
  store.prune({ days: 7 });
  assert.equal(store.status().counts.failure_contexts, 1);
  store.close();
  removeRoot(root);
});

test("size-based eviction removes lowest-value failures first and never confirmed actions", () => {
  const { store, root } = openMemory();
  // Deterministic pressure fixture: eviction frees space as contexts disappear, so confirmed inserts continue.
  let extraBytes = 0;
  store.bytesUsed = () => 1024 * 1024 + extraBytes + (store.db.prepare("SELECT COUNT(*) AS c FROM failure_contexts").get().c > 0 ? 32 * 1024 * 1024 : 0);
  store.writeMeta("quota_bytes", 1024 * 1024);
  for (let index = 0; index < 60; index += 1) {
    recordFailure(store, { hostname: `fail-${index}.example`, label: `Failure ${index}`, errorCode: "timeout", daysAgo: index % 3 });
  }
  for (let index = 0; index < 60; index += 1) {
    store.record({ success: true, capability: "browser.tab.create", hostname: `ok-${index}.example`, label: `Ok ${index}` });
  }
  const after = store.status();
  assert.equal(after.counts.failure_contexts, 0, "all negative lessons evicted before anything else");
  assert.ok(after.counts.signatures >= 60, "confirmed signatures are never auto-purged");
  const confirmed = store.db.prepare("SELECT COALESCE(SUM(confirmed_count),0) AS c FROM signatures").get().c;
  assert.ok(confirmed >= 60);
  // once only confirmed data remains and the store is still over quota, capture pauses
  extraBytes = 32 * 1024 * 1024;
  store.configure({ quota_bytes: 1024 * 1024 });
  assert.equal(store.status().health, "quota_reached");
  store.close();
  removeRoot(root);
});

test("prune records last run and returns counts", () => {
  const { store, root } = openMemory();
  recordFailure(store, { daysAgo: 30 });
  const result = store.prune({ days: 7 });
  assert.ok(result.removed >= 1);
  assert.equal(result.evicted >= 0, true);
  assert.ok(store.status().last_prune_at);
  store.close();
  removeRoot(root);
});