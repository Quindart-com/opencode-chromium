import assert from "node:assert/strict";
import { test } from "bun:test";
import { RpcRelay } from "../../native-host/src/rpc-relay.ts";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";
import { deadlineError } from "../../src/shared/deadline.ts";
import { FrameDecoder } from "../../src/shared/node-framing.ts";

test("native Firefox timeout details survive both relay boundaries", async () => {
  let receive;
  const port = { onMessage: { addListener: callback => { receive = callback; } }, onDisconnect: { addListener() {} }, postMessage: message => relay.handleExtensionMessage(message) };
  const rpc = new NativeRpc({ chrome: { runtime: { connectNative: () => port } }, hostName: "fixture", timeoutMs: 1000, status() {}, connected() {}, disconnected() {} });
  const relay = new RpcRelay({ state: {}, extensionWriter: message => receive(message), localHandler: () => { throw deadlineError({ phase: "Firefox command", method: "input.performActions", tabId: 3, dialogType: "prompt" }); } });
  rpc.connect();
  await assert.rejects(rpc.request("firefox.command", {}), error => {
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.retryable, false);
    assert.equal(error.uncertain, true);
    assert.deepEqual(error.details, { phase: "Firefox command", method: "input.performActions", tabId: 3, dialogType: "prompt" });
    return true;
  });
});

test("native admission failure returns a reply without dispatching that client's command", async () => {
  const createSocket = () => {
    const replies = [];
    const decoder = new FrameDecoder({ onMessage: reply => replies.push(reply) });
    return { replies, write(frame, done) { decoder.push(frame); done(); } };
  };
  const blocked = createSocket(), ready = createSocket();
  const forwarded = [];
  let attempts = 0, leaves = 0;
  const relay = new RpcRelay({
    state: { startedAt: "fixture", profile: null },
    extensionWriter: message => { if (message.method === "executeCdp") forwarded.push(message); },
    admit: async () => {
      if (++attempts === 1) throw new Error("Runtime update is busy; retry shortly");
      return () => { leaves++; };
    },
  });
  const request = tabId => ({ jsonrpc: "2.0", id: 1, method: "executeCdp", params: { tabId, method: "Input.dispatchMouseEvent" } });
  try {
    await Promise.all([relay.handleClientMessage(blocked, request(1)), relay.handleClientMessage(ready, request(2))]);
    assert.deepEqual(forwarded.map(message => message.params.tabId), [2]);
    await relay.handleExtensionMessage({ jsonrpc: "2.0", id: forwarded[0].id, result: {} });
    assert.deepEqual(ready.replies, [{ jsonrpc: "2.0", id: 1, params: {}, result: {} }]);
    assert.equal(blocked.replies.length, 1);
    assert.equal(blocked.replies[0].id, 1);
    assert.deepEqual(blocked.replies[0].error.data, { code: "RUNTIME_ADMISSION_FAILED", executionState: "not_started", retryable: false, uncertain: false });
    assert.equal(leaves, 1);
  } finally { relay.shutdown(); }
});
