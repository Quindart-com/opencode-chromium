import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryCapture, HistoryStore } from "../../native-host/src/history/index.js";
import { RpcRelay } from "../../native-host/src/rpc-relay.js";

function fakeSocket() {
  return {
    destroy() {},
    on() {},
    write(_chunk, callback) {
      if (typeof callback === "function") callback();
    },
  };
}

test("the native host relay records agent actions as encrypted history events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-relay-"));
  const store = new HistoryStore({ root });
  try {
    store.enable();
    const capture = new HistoryCapture({ store });
    const extensionOut = [];
    const relay = new RpcRelay({
      state: { startedAt: new Date().toISOString() },
      extensionWriter: (message) => extensionOut.push(message),
      history: capture,
      localHandler: async () => undefined,
    });

    const socket = fakeSocket();
    await relay.handleClientMessage(socket, {
      jsonrpc: "2.0",
      id: 1,
      method: "finalizeTabs",
      params: { session_id: "relay-session", profile_id: "p1", keep: [1] },
    });
    const forwarded = extensionOut.find((message) => message.method === "finalizeTabs");
    assert.ok(forwarded, "agent request must be forwarded to the extension");
    await relay.handleExtensionMessage({
      jsonrpc: "2.0",
      id: forwarded.id,
      result: { profiles: {} },
    });
    store.flushSync();

    const events = store.list({ limit: 50 }).events;
    const started = events.find((event) => event.type === "opencode-browser-plugin.history.action_started.v0");
    const completed = events.find((event) => event.type === "opencode-browser-plugin.history.action_completed.v0");
    assert.ok(started, "action_started recorded");
    assert.ok(completed, "action_completed recorded");
    assert.equal(completed.data.session_id, "relay-session");
    assert.equal(completed.data.capability, "browser.session.finalize");
    assert.equal(completed.data.payload.effect, "confirmed");
    assert.equal(completed.data.action_id, started.data.action_id);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the native host relay marks failed and timed-out actions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-relay-"));
  const store = new HistoryStore({ root });
  try {
    store.enable();
    const capture = new HistoryCapture({ store });
    const extensionOut = [];
    const relay = new RpcRelay({
      state: { startedAt: new Date().toISOString() },
      extensionWriter: (message) => extensionOut.push(message),
      history: capture,
      localHandler: async () => undefined,
    });

    const socket = fakeSocket();
    await relay.handleClientMessage(socket, {
      jsonrpc: "2.0",
      id: 2,
      method: "closeTab",
      params: { session_id: "relay-session", tabId: 7 },
    });
    const forwarded = extensionOut.find((message) => message.method === "closeTab");
    await relay.handleExtensionMessage({
      jsonrpc: "2.0",
      id: forwarded.id,
      error: { code: -32000, message: "boom", data: { code: "BABOOM" } },
    });
    store.flushSync();

    const events = store.list({ limit: 50 }).events;
    const failed = events.find((event) => event.type === "opencode-browser-plugin.history.action_completed.v0" && event.data.capability === "browser.tab.close");
    assert.ok(failed);
    assert.equal(failed.data.payload.effect, "failed");
    assert.equal(failed.data.payload.error_code, "BABOOM");
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("boom"), false, "raw error text must not be stored");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});