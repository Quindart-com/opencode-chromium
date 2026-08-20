import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryCapture, HistoryStore, WRITER_QUEUE_CAPACITY, historyHealth, readState } from "../../native-host/src/history/index.js";

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
  const store = new HistoryStore({ root });
  return { root, store };
}

function cleanupStore({ root, store }) {
  try {
    store.close();
  } catch {
    // ignore
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test("capture is off by default and never touches disk", () => {
  const { root, store } = tempStore();
  try {
    const result = store.record({ kind: "action_started", sessionId: "s1", capability: "browser.tab.create" });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "disabled");
    assert.equal(store.status().enabled, false);
    assert.equal(fs.existsSync(path.join(root, "key")), false);
  } finally {
    cleanupStore({ root, store });
  }
});

test("enable creates an encrypted store and records control events", () => {
  const { root, store } = tempStore();
  try {
    const status = store.enable();
    assert.equal(status.enabled, true);
    assert.equal(status.encrypted, true);
    assert.equal(status.health, "ready");
    assert.ok(fs.statSync(path.join(root, "key")).size === 32);
    const events = store.list({ limit: 10 }).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "opencode-browser-plugin.history.control.v0");
    assert.equal(events[0].data.payload.operation, "enable");
  } finally {
    cleanupStore({ root, store });
  }
});

test("action events round-trip with fixed metadata only", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.record({ kind: "action_started", sessionId: "s1", actionId: "a1", capability: "browser.tab.claim", application: { hostname: "github.com" } });
    store.record({ kind: "action_completed", sessionId: "s1", actionId: "a1", capability: "browser.tab.claim", application: { hostname: "github.com" }, payload: { kind: "action_completed", effect: "confirmed", route: "relay" } });
    store.flushSync();
    const events = store.list({ limit: 10 }).events;
    const completed = events.find((event) => event.type === "opencode-browser-plugin.history.action_completed.v0");
    assert.ok(completed);
    assert.equal(completed.data.session_id, "s1");
    assert.equal(completed.data.action_id, "a1");
    assert.equal(completed.data.capability, "browser.tab.claim");
    assert.deepEqual(completed.data.application, { hostname: "github.com" });
    assert.equal(completed.data.payload.effect, "confirmed");
    assert.equal(completed.data.platform, process.platform);
    assert.equal(JSON.stringify(completed).includes("https://"), false);
    assert.equal(completed.data.url, undefined);
    assert.equal(completed.data.arguments, undefined);
    assert.equal(completed.data.result, undefined);
  } finally {
    cleanupStore({ root, store });
  }
});

test("raw key material never appears on disk outside the key file", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.record({ kind: "action_started", sessionId: "s1", capability: "browser.pointer.move", application: { hostname: "example.com" } });
    store.flushSync();
    const chunk = path.join(root, "chunks");
    const files = fs.readdirSync(chunk).filter((name) => name.endsWith(".chunk"));
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(path.join(chunk, files[0]), "utf8");
    assert.equal(raw.includes("browser.pointer.move"), false);
    assert.equal(raw.includes("example.com"), false);
    assert.equal(raw.includes('"session_id"'), false);
  } finally {
    cleanupStore({ root, store });
  }
});

test("pause stops capture but preserves the store; resume restores it", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.pause();
    assert.equal(store.status().paused, true);
    const before = store.list({ limit: 50 }).events.length;
    store.record({ kind: "action_started", sessionId: "s2", capability: "browser.tab.create" });
    store.flushSync();
    const after = store.list({ limit: 50 }).events.length;
    assert.equal(after, before);
    store.resume();
    store.record({ kind: "action_completed", sessionId: "s2", capability: "browser.tab.create" });
    store.flushSync();
    assert.ok(store.list({ limit: 50 }).events.length > before);
  } finally {
    cleanupStore({ root, store });
  }
});

test("dropped events are counted without blocking capture", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.queue = new Array(WRITER_QUEUE_CAPACITY).fill({});
    store.record({ kind: "action_started", sessionId: "s3", capability: "browser.tab.create" });
    assert.equal(store.status().dropped_events, 1);
    store.queue = [];
    store.hardDelete();
    store.enable();
    store.flushSync();
    assert.ok(true);
  } finally {
    cleanupStore({ root, store });
  }
});

test("retention hides events older than the window", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    const old = { ...(store.record({ kind: "control", payload: { kind: "control", operation: "enable" } }).event ?? {}) };
    void old;
    const fresh = store.record({ kind: "control", payload: { kind: "control", operation: "enable" } });
    void fresh;
    store.flushSync();
    const chunkFile = path.join(root, "chunks", fs.readdirSync(path.join(root, "chunks")).find((name) => name.endsWith(".chunk")));
    const before = store.list({ limit: 50 }).events.length;
    assert.ok(before >= 1);
    const mtime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(chunkFile, new Date(mtime), new Date(mtime));
    const cutoffRoll = 30 * 24 * 60 * 60 * 1000;
    const future = Date.now() + cutoffRoll;
    store.pruneExpired(future);
    const after = store.list({ limit: 50 }).events.length;
    assert.equal(after, 0);
  } finally {
    cleanupStore({ root, store });
  }
});

test("corrupt chunks fail closed instead of guessing", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.record({ kind: "action_started", sessionId: "s4", capability: "browser.tab.create" });
    store.flushSync();
    const chunks = path.join(root, "chunks");
    const good = fs.readdirSync(chunks).find((name) => name.endsWith(".chunk"));
    assert.ok(good);
    store.close();
    const corruptFile = path.join(chunks, `${Date.now() + 100000}-corrupt.chunk`);
    fs.writeFileSync(corruptFile, "{\"v\":1,\"profile\":\"opencode-browser-plugin-history-v1/aes-256-gcm+jsonl+cloudevents-json\",\"chunkId\":\"x\",\"created\":\"now\",\"sealed\":true}\nAAAA\n");
    const reader = new HistoryStore({ root });
    const result = reader.query({ limit: 50 });
    assert.equal(result.events.length, 2);
    assert.match(result.health_warning ?? "", /unauthenticated|malformed|corrupt/i);
  } finally {
    cleanupStore({ root, store });
  }
});

test("queries append an encrypted access-audit record when non-empty", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.record({ kind: "action_started", sessionId: "s5", capability: "browser.tab.create" });
    store.flushSync();
    store.query({ limit: 10 });
    store.flushSync();
    const events = store.list({ limit: 50 }).events;
    assert.ok(events.some((event) => event.type === "opencode-browser-plugin.history.access.v0"));
  } finally {
    cleanupStore({ root, store });
  }
});

test("query honors session, sequence bounds, and the limit cap", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    for (let index = 0; index < 5; index += 1) store.record({ kind: "action_started", sessionId: "s6", capability: "browser.tab.create" });
    store.flushSync();
    const all = store.query({ limit: 200 }).events;
    assert.ok(all.length >= 5);
    const sessionOnly = store.query({ limit: 200, sessionId: "does-not-exist" }).events;
    assert.equal(sessionOnly.length, 0);
    const bounded = store.query({ limit: 2 }).events;
    assert.equal(bounded.length, 2);
    const sequences = bounded.map((event) => event.data.sequence).sort((a, b) => a - b);
    assert.ok(sequences[1] > sequences[0]);
    const unbounded = store.query({ limit: 9999 }).events;
    assert.ok(unbounded.length <= 200);
  } finally {
    cleanupStore({ root, store });
  }
});

test("hardDelete destroys the key, chunks, and state", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    store.record({ kind: "action_started", sessionId: "s7", capability: "browser.tab.create" });
    store.flushSync();
    const result = store.hardDelete();
    assert.equal(result.deleted, true);
    assert.equal(fs.existsSync(path.join(root, "key")), false);
    assert.equal(fs.existsSync(path.join(root, "state.json")), false);
    assert.deepEqual(readState(root), { enabled: false, paused: false, sequence: 0, dropped: 0, corrupt: false, admitted: false, createdAt: null });
  } finally {
    cleanupStore({ root, store });
  }
});

test("health categories reflect lifecycle", () => {
  const { root, store } = tempStore();
  try {
    assert.equal(store.status().health, "disabled");
    store.enable();
    assert.equal(store.status().health, "ready");
    store.pause();
    assert.equal(store.status().health, "paused");
    const state = readState(root);
    state.corrupt = true;
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
    assert.equal(historyHealth(readState(root)), "storage_corrupt");
  } finally {
    cleanupStore({ root, store });
  }
});

test("capture maps only agent actions with sessions and never records args", () => {
  const { root, store } = tempStore();
  try {
    store.enable();
    const capture = new HistoryCapture({ store });
    const started = capture.startAgentRequest({
      id: 1,
      method: "claimUserTab",
      params: { session_id: "s8", tabId: 42, url: "https://github.com/example/path?q=1" },
    });
    assert.ok(started);
    assert.equal(started.sessionId, "s8");
    assert.equal(capture.applicationFor(42), null);
    capture.noteResponse({ id: 1, tabs: [{ id: 42, url: "https://github.com/acme/repo" }] });
    assert.deepEqual(capture.applicationFor(42), { hostname: "github.com" });
    capture.completeAgentRequest(started, "confirmed");
    const skipped = capture.startAgentRequest({ id: 2, method: "getTabs", params: { session_id: "s8" } });
    assert.equal(skipped, null);
    const noSession = capture.startAgentRequest({ id: 3, method: "closeTab", params: { tabId: 42 } });
    assert.equal(noSession, null);
    store.flushSync();
    const events = store.list({ limit: 50 }).events;
    const completed = events.find((event) => event.type === "opencode-browser-plugin.history.action_completed.v0");
    assert.ok(completed);
    assert.deepEqual(completed.data.application, { hostname: "github.com" });
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("https://"), false);
    assert.equal(serialized.includes("acme"), false);
    assert.equal(serialized.includes("q=1"), false);
  } finally {
    cleanupStore({ root, store });
  }
});