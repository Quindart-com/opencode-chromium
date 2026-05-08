import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, FrameDecoder } from "../src/framing.js";

test("encodes and decodes a framed JSON message", () => {
  const messages = [];
  const decoder = new FrameDecoder({ onMessage: (message) => messages.push(message) });
  const frame = encodeFrame({ jsonrpc: "2.0", id: 1, result: "pong" });

  decoder.push(frame);

  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, result: "pong" }]);
});

test("decodes frames split across chunks", () => {
  const messages = [];
  const decoder = new FrameDecoder({ onMessage: (message) => messages.push(message) });
  const frame = encodeFrame({ method: "ping", params: {} });

  decoder.push(frame.subarray(0, 2));
  decoder.push(frame.subarray(2, 7));
  decoder.push(frame.subarray(7));

  assert.deepEqual(messages, [{ method: "ping", params: {} }]);
});

test("decodes multiple frames from one chunk", () => {
  const messages = [];
  const decoder = new FrameDecoder({ onMessage: (message) => messages.push(message) });
  const chunk = Buffer.concat([
    encodeFrame({ id: 1, result: true }),
    encodeFrame({ id: 2, result: false }),
  ]);

  decoder.push(chunk);

  assert.deepEqual(messages, [
    { id: 1, result: true },
    { id: 2, result: false },
  ]);
});
