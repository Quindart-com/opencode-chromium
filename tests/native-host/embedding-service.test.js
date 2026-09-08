import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddingService } from "../../native-host/src/memory/embedding-service.ts";
import { EmbedQueue } from "../../native-host/src/memory/embed.js";

test("embedding service serializes work and rejects malformed batches", async () => {
  let active = 0;
  let peak = 0;
  const service = new EmbeddingService(async (texts) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    --active;
    return { vectors: texts.map(() => [1, 0]), dims: 2 };
  });
  try {
    await Promise.all([service.run(["first"]), service.run(["second"])]);
    assert.equal(peak, 1);
  } finally { service.close(); }
  const invalid = new EmbeddingService(async () => ({ vectors: [[1]], dims: 2 }));
  try { await assert.rejects(invalid.run(["fixture"]), /Embedding batch failed/); }
  finally { invalid.close(); }
});

test("queue coalesces duplicate work and limits each batch", async () => {
  const sizes = [];
  const fingerprints = [];
  const queue = new EmbedQueue({
    embed: async (texts) => { sizes.push(texts.length); return { vectors: texts.map(() => [1, 0]), dims: 2 }; },
    onResults: (rows) => fingerprints.push(...rows.map((row) => row.fingerprint)),
  });
  try {
    queue.push({ fingerprint: "same", text: "first" });
    queue.push({ fingerprint: "same", text: "updated" });
    for (let i = 0; i < 40; i++) queue.push({ fingerprint: String(i), text: "fixture" });
    await queue.flush();
    assert.equal(fingerprints.length, 41);
    assert.ok(sizes.every((size) => size <= 16));
  } finally { queue.close(); }
});

test("closing a queue prevents late model results from writing to storage", async () => {
  let finish;
  let writes = 0;
  const queue = new EmbedQueue({ embed: () => new Promise((resolve) => { finish = resolve; }), onResults: () => { writes++; } });
  queue.push({ fingerprint: "fixture", text: "fixture" });
  const pending = queue.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.close();
  finish({ vectors: [[1, 0]], dims: 2 });
  await pending;
  assert.equal(writes, 0);
});
