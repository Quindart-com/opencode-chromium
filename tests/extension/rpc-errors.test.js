import assert from "node:assert/strict";
import test from "node:test";
import { RpcRelay } from "../../native-host/src/rpc-relay.ts";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";
import { deadlineError } from "../../src/shared/deadline.ts";

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
