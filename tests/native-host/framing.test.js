import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, FrameDecoder } from "../../native-host/src/framing.js";

test("decodes a large message in single-byte fragments", () => {
  const expected = { text: "x".repeat(20000) };
  const messages = [];
  const decoder = new FrameDecoder({ onMessage: (value) => messages.push(value) });
  for (const byte of encodeFrame(expected)) decoder.push(Uint8Array.of(byte));
  assert.deepEqual(messages, [expected]);
});

test("rejects oversized frames before allocating a payload", () => {
  const decoder = new FrameDecoder({ maxFrameBytes: 64, onMessage() {} });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1024);
  assert.throws(() => decoder.push(header), /Invalid frame length/);
  assert.throws(() => encodeFrame(undefined), /JSON value/);
});

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
