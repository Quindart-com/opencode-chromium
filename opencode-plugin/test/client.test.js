import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserHostRpcError, validateJsonRpcResponse } from "../src/client.js";

test("validates successful JSON-RPC responses", () => {
  const result = validateJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }, 1, "ping");

  assert.deepEqual(result, { ok: true });
});

test("ignores responses for other request ids", () => {
  const result = validateJsonRpcResponse({ jsonrpc: "2.0", id: 2, result: { ok: true } }, 1, "ping");

  assert.equal(result, null);
});

test("rejects invalid successless responses", () => {
  assert.throws(
    () => validateJsonRpcResponse({ jsonrpc: "2.0", id: 1 }, 1, "ping"),
    /exactly one of result or error/,
  );
});

test("preserves JSON-RPC error details", () => {
  assert.throws(
    () => validateJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom", data: { tabId: 1 } } }, 1, "ping"),
    (error) => error instanceof BrowserHostRpcError && error.code === -32000 && error.data.tabId === 1,
  );
});
