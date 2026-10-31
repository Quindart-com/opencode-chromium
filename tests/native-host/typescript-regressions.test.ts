import assert from "node:assert/strict";
import { test } from "bun:test";
import { float32FromBuffer, embedBufferFromRows } from "../../native-host/src/memory/rank.ts";
import { parseTrace } from "../../native-host/src/diagnostics/trace-parser.ts";
import { normalizeError } from "../../src/core/errors.ts";
import { FirefoxBackend, localValue, remoteValue } from "../../native-host/src/firefox/backend.ts";

test("embedding blobs preserve typed rows and unaligned views", () => {
  const encoded = embedBufferFromRows([new Float32Array([0.25, -0.5]), new Float32Array([1, 0])]);
  assert.deepEqual(Array.from(float32FromBuffer(encoded)), [0.25, -0.5, 1, 0]);
  const unaligned = new Uint8Array(encoded.length + 1);
  unaligned.set(encoded, 1);
  assert.deepEqual(Array.from(float32FromBuffer(unaligned.subarray(1))), [0.25, -0.5, 1, 0]);
  assert.throws(() => float32FromBuffer(new Uint8Array(3)), RangeError);
});

test("trace accounting distinguishes requests that share a URL", () => {
  const events = [
    { name: "ResourceSendRequest", ts: 1, args: { data: { requestId: "document", url: "https://site.example/", resourceType: "Document" } } },
    ...["a", "b"].map((requestId, index) => ({ name: "ResourceSendRequest", ts: 2 + index, args: { data: { requestId, url: "https://cdn.example/shared.js", resourceType: "Script" } } })),
    { name: "ResourceFinish", ts: 12, args: { data: { requestId: "document", transferSize: 500 } } },
    ...[100, 350].map((transferSize, index) => ({ name: "ResourceFinish", ts: 10 + index, args: { data: { requestId: index ? "b" : "a", transferSize } } })),
  ];
  const metrics = parseTrace(events);
  assert.equal(metrics.thirdParty["cdn.example"]?.requests, 2);
  assert.equal(metrics.thirdParty["cdn.example"]?.transferBytes, 450);
});

test("a disconnected operation remains retryable and uncertain", () => {
  const result = normalizeError(new Error("Browser connection disconnected"));
  assert.equal(result.retryable, true);
  assert.equal(result.uncertain, true);
});

test("Firefox rejects a closed transport without leaving a pending request", async () => {
  const backend = new FirefoxBackend();
  await assert.rejects(backend.send("browsingContext.getTree", {}), /connection is closed/);
  assert.equal(backend.pending.size, 0);
});

test("Firefox script arguments preserve nested values", () => {
  const input = { title: "Ready", enabled: true, items: [1, null, { value: "nested" }] };
  assert.deepEqual(remoteValue(localValue(input)), input);
});
