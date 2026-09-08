import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../../native-host/src/memory/store.js";
import { safeSelector } from "../../native-host/src/memory/privacy.js";
import { sqliteImplementation } from "../../native-host/src/memory/config.js";

function stores(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reliability-"));
  const opened = Array.from({ length: count }, () => new MemoryStore({ root }));
  t.after(async () => {
    for (const store of opened) store.close();
    globalThis.Bun?.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("memory-reliability-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  });
  return opened;
}

test("profile statistics isolate executions and deduplicate shared recipes", async (t) => {
  const [first, second] = stores(t, 2);
  first.enable();
  first.profiles.register({ profileId: "alpha", profileLabel: "Primary" });
  first.recordStep({ action: "click", hostname: "fixture.test", profileId: "alpha" });
  second.recordStep({ action: "click", hostname: "fixture.test", profileId: "beta", success: false });
  first.recordStep({ action: "navigate", hostname: "history.test" });
  const alpha = first.status({ profileIds: ["alpha"] });
  const beta = first.status({ profileIds: ["beta"] });
  const both = second.status({ profileIds: ["alpha", "beta", "alpha"] });
  assert.equal(alpha.counts.executions_v2, 1);
  assert.equal(alpha.counts.negative_actions_v2, 0);
  assert.equal(beta.counts.negative_actions_v2, 1);
  assert.equal(both.counts.executions_v2, 2);
  assert.equal(both.counts.actions_v2, 1);
  assert.equal(first.status({ profileIds: [], includeUnattributed: true }).counts.actions_v2, 1);
  assert.equal(first.status().counts.executions_v2, 3);
  second.profiles.register({ profileId: "alpha", profileLabel: "Renamed" });
  assert.equal(first.profiles.list().find((item) => item.profileId === "alpha").profileLabel, "Renamed");
  assert.equal(first.status({ profileIds: ["alpha"] }).counts.executions_v2, 1);
  await first.search({ query: "missing", profileId: "alpha" });
  assert.equal(second.status({ profileIds: ["alpha"] }).usage.search_queries, 1);
  assert.equal(second.status({ profileIds: ["beta"] }).usage.search_queries, 0);
});

test("an in-progress replay counts as an attempt without inventing a success rate", (t) => {
  const [store] = stores(t);
  store.usageEvent({ eventType: "replay_started", profileId: "alpha" });
  const usage = store.status({ profileIds: ["alpha"] }).usage;
  assert.equal(usage.replay_attempts, 1);
  assert.equal(usage.replay_success_rate, null);
});

test("action attribution failures roll back counters and recipes together", (t) => {
  const [store] = stores(t);
  store.enable();
  store.profiles.attribute = () => { throw new Error("fixture attribution failure"); };
  assert.throws(() => store.recordStep({ action: "click", profileId: "fixture" }), /attribution failure/);
  assert.equal(store.status().counts.actions_v2, 0);
  assert.equal(store.status().counts.executions_v2, 0);
});

test("turning off expanded storage restores the standard quota", (t) => {
  const [store] = stores(t);
  store.configure({ power_user: true, quota_bytes: 200 * 1024 * 1024 });
  store.configure({ power_user: false });
  assert.equal(store.status().quota_bytes, 100 * 1024 * 1024);
  assert.throws(() => store.configure({ quota_bytes: 200 * 1024 * 1024 }), /expanded storage/);
});

test("schema migration creates a consistent snapshot with committed WAL data", (t) => {
  const opened = stores(t);
  const first = opened[0];
  first.enable();
  first.recordStep({ action: "click", hostname: "fixture.test" });
  first.writeMeta("schema_version", 2);
  opened.push(new MemoryStore({ root: first.root }));
  assert.equal(opened[1].status().schema_version, 3);
  const backup = fs.readdirSync(first.root).find((name) => name.startsWith("memory.db.backup-"));
  assert.ok(backup);
  const snapshot = new (sqliteImplementation().Database)(path.join(first.root, backup));
  try {
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM memory_actions_v2").get().n, 1);
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { snapshot.close(); }
});

test("rebuild failures are visible and a later successful rebuild repairs health", async (t) => {
  const [store] = stores(t);
  store.enable();
  store.recordStep({ action: "click", hostname: "fixture.test" });
  await assert.rejects(store.reindex({ embed: async () => { throw new Error("fixture model failure"); } }), /model failure/);
  assert.equal(store.status().health, "embedding_errors");
  assert.equal(store.status().last_reindex_at, null);
  await store.reindex({ embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), dims: 2, model: "fixture", embeddingProfile: "fixture:2" }) });
  assert.equal(store.status().health, "ready");
  assert.equal(store.status().counts.unindexed_actions, 0);
});

test("capture settings are shared by already-open database connections", (t) => {
  const [first, second] = stores(t, 2);
  first.enable();
  assert.equal(second.status().enabled, true);
  assert.equal(second.recordStep({ action: "click", hostname: "fixture.test" }).accepted, true);
  second.disable();
  assert.equal(first.status().enabled, false);
  assert.equal(first.recordStep({ action: "click" }).accepted, false);
  first.enable();
  second.pause();
  assert.equal(first.recordStep({ action: "click" }).accepted, false);
  second.resume();
  assert.equal(first.recordStep({ action: "click" }).accepted, true);
});

test("embedding batches are atomic on both supported database runtimes", (t) => {
  const [store] = stores(t);
  store.enable();
  const first = store.recordStep({ action: "click", hostname: "first.test" });
  const second = store.recordStep({ action: "click", hostname: "second.test" });
  const apply = store.applyEmbeddingV2.bind(store);
  store.applyEmbeddingV2 = (row) => {
    if (row.fingerprint === second.fingerprint) throw new Error("fixture write failure");
    return apply(row);
  };
  const rows = [first, second].map(({ fingerprint }) => ({ fingerprint: `v2:action:${fingerprint}`, values: [1, 0] }));
  assert.throws(() => store.applyEmbeddings(rows, "fixture", 2, "fixture:2"), /fixture write failure/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memory_actions_v2 WHERE embedding IS NOT NULL").get().n, 0);
  store.applyEmbeddingV2 = apply;
  store.applyEmbeddings(rows, "fixture", 2, "fixture:2");
  assert.equal(store.status().counts.unindexed_actions, 0);
});

test("v2 cleanup removes expired negative recipes and preserves confirmed actions", (t) => {
  const [store] = stores(t);
  store.enable();
  for (const success of [false, true]) {
    const chainId = `fixture-${success}`;
    store.recordStep({ chainId, position: 0, action: "click", hostname: `${success}.test`, success });
    store.finalizeChain({ chainId, success });
  }
  const old = new Date(Date.now() - 45 * 86400000).toISOString();
  store.db.prepare("UPDATE memory_actions_v2 SET last_seen = ?").run(old);
  store.db.prepare("UPDATE memory_chains_v2 SET last_seen = ?").run(old);
  store.prune({ days: 7 });
  assert.equal(store.status().counts.actions_v2, 1);
  assert.equal(store.status().counts.chains_v2, 1);
  assert.equal(store.status().counts.negative_actions_v2, 0);
});

test("v2 capture stops at the configured quota", (t) => {
  const [store] = stores(t);
  store.enable();
  store.bytesUsed = () => store.statusQuota + 1;
  store.statusQuota = Number(store.meta.quota_bytes);
  assert.equal(store.recordStep({ action: "click" }).accepted, false);
  assert.equal(store.status().health, "quota_reached");
});

test("invalid configuration never partially changes valid fields", (t) => {
  const [store] = stores(t);
  const before = store.status().quota_bytes;
  assert.throws(() => store.configure({ quota_bytes: before * 2, purge_days: 0 }));
  assert.equal(store.status().quota_bytes, before);
});

test("memory selectors cannot retain form values or arbitrary attributes", () => {
  assert.equal(safeSelector('input[value="fixture-secret"]'), null);
  assert.equal(safeSelector('[data-token="fixture-secret"]'), null);
  assert.equal(safeSelector('button[role="button"]'), 'button[role="button"]');
});
