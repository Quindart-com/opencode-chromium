import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../../native-host/src/memory/store.js";
import { safeSelector } from "../../native-host/src/memory/privacy.js";

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
