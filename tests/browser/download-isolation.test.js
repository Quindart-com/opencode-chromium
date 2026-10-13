import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createDownloadEvents, registerDownloadHandlers } from "../../extension-src/entrypoints/background/download-events.js";
import { assertTabAccess } from "../../extension-src/entrypoints/background/tab-ownership.js";
import { FirefoxBackend } from "../../native-host/src/firefox/backend.js";

function fixture(options = {}) {
  const owners = new Map([[1, "first"], [2, "second"], [3, "first"]]);
  const downloads = createDownloadEvents({ ownerForTab: tabId => owners.get(tabId), clock: () => "2026-01-01T00:00:00.000Z", ...options });
  const start = (tabId, guid) => downloads.capture(tabId, "Page.downloadWillBegin", { guid, url: "https://example.test/report.pdf", suggestedFilename: "report.pdf" });
  return { owners, downloads, start };
}

test("download capture excludes user tabs and unattributed global download events", () => {
  const { downloads, start } = fixture();
  start(1, "first-download");
  start(2, "second-download");
  start(99, "user-download");
  downloads.capture(1, "downloads.onCreated", { id: 123, url: "https://example.test/private.pdf" });
  downloads.capture(1, "Browser.downloadWillBegin", { guid: "global-download", url: "https://example.test/private.pdf" });
  downloads.capture(1, "Page.downloadProgress", { guid: "user-download", state: "completed" });
  assert.deepEqual(downloads.read({ sessionId: "first" }).map(event => event.id), ["first-download"]);
  assert.deepEqual(downloads.read({ sessionId: "second" }).map(event => event.id), ["second-download"]);
});

test("download reads and clears require an owner, reject another session's tab, and leave other downloads intact", async () => {
  const { downloads, start } = fixture();
  start(1, "one"); start(2, "two"); start(3, "three");
  const handlers = new Map();
  registerDownloadHandlers({ rpc: { register: (method, handler) => handlers.set(method, handler) }, downloads, requiredSessionId: params => params.session_id });
  const read = handlers.get("getDownloadEvents"); const clear = handlers.get("clearDownloadEvents");
  await assert.rejects(read({}), /Expected session_id/);
  await assert.rejects(clear({}), /Expected session_id/);
  await assert.rejects(read({ session_id: "first", tabId: 2 }), /not controlled/);
  await assert.rejects(clear({ session_id: "first", tabId: 2 }), /not controlled/);
  await clear({ session_id: "first", tabId: 1 });
  assert.deepEqual((await read({ session_id: "first" })).events.map(event => event.id), ["three"]);
  assert.deepEqual((await read({ session_id: "second" })).events.map(event => event.id), ["two"]);
  await clear({ session_id: "first" });
  assert.equal((await read({ session_id: "first" })).events.length, 0);
  assert.equal((await read({ session_id: "second" })).events.length, 1);
});

test("identical URLs cannot substitute for protocol GUIDs or change a captured download owner", () => {
  const { owners, downloads, start } = fixture();
  start(1, "same-guid");
  start(2, "same-guid");
  downloads.capture(2, "Page.downloadProgress", { guid: "same-guid", state: "completed" });
  assert.equal(downloads.read({ sessionId: "second" }).length, 0);
  assert.equal(downloads.read({ sessionId: "first" }).at(-1).status, "started");
  owners.set(1, "second");
  downloads.capture(1, "Page.downloadProgress", { guid: "same-guid", state: "completed" });
  start(1, "same-guid");
  assert.equal(downloads.read({ sessionId: "second" }).length, 0);
  assert.equal(downloads.read({ sessionId: "first" }).length, 0);
  owners.set(1, "first");
  assert.equal(downloads.read({ sessionId: "first" }).at(-1).status, "complete");
});

test("download capture omits URL credentials, query strings, fragments, full file paths, and raw delta objects", () => {
  const { downloads } = fixture();
  const privateQuery = crypto.randomUUID();
  downloads.capture(1, "Page.downloadWillBegin", { guid: "private-url", url: `https://user:password@example.test/report.pdf?signature=${privateQuery}&name=private#fragment`, suggestedFilename: "C:\\Users\\fixture\\Downloads\\report.pdf", extra: "private" });
  downloads.capture(1, "Page.downloadProgress", { guid: "private-url", state: "completed", filePath: "/home/fixture/downloads/saved.pdf", receivedBytes: 25, totalBytes: 25, delta: { url: privateQuery } });
  const events = downloads.read({ sessionId: "first" });
  assert.equal(events[0].url, "https://example.test/report.pdf");
  assert.equal(events[0].filename, "report.pdf");
  assert.equal(events[1].filename, "saved.pdf");
  assert.equal(events[1].bytesReceived, 25);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(privateQuery));
  assert.doesNotMatch(JSON.stringify(events), /password|fixture|fragment|delta/);
  downloads.recordInline(1, "inline-one", { url: "data:application/pdf;base64,cHJpdmF0ZQ==", filename: "/home/fixture/inline.pdf" });
  assert.equal(downloads.read({ sessionId: "first" }).at(-1).url, null);
  assert.equal(downloads.read({ sessionId: "first" }).at(-1).filename, "inline.pdf");
});

test("clearing history preserves progress provenance and terminal state cannot regress", () => {
  const { downloads, start } = fixture();
  start(1, "owned");
  downloads.clear({ sessionId: "first" });
  start(2, "owned");
  downloads.capture(1, "Page.downloadProgress", { guid: "owned", state: "completed", totalBytes: 9, receivedBytes: 9 });
  downloads.capture(1, "Page.downloadProgress", { guid: "owned", state: "inProgress", totalBytes: 9, receivedBytes: 0 });
  assert.deepEqual(downloads.read({ sessionId: "first" }).map(event => event.status), ["complete"]);
  assert.deepEqual(downloads.read({ sessionId: "second" }), []);
});

test("download buffers are bounded per session and one session cannot flush another's history", () => {
  const { downloads, start } = fixture({ maxEvents: 2 });
  start(1, "one");
  for (let index = 0; index < 5; index++) start(2, `second-${index}`);
  assert.equal(downloads.read({ sessionId: "first" }).length, 1);
  assert.equal(downloads.read({ sessionId: "second", limit: 10000 }).length, 2);
  const event = downloads.read({ sessionId: "first" })[0];
  event.filename = "modified";
  assert.equal(downloads.read({ sessionId: "first" })[0].filename, "report.pdf");
});

test("Firefox downloads retain verified context identity and protocol download ID", () => {
  const { downloads } = fixture();
  const backend = new FirefoxBackend({ onEvent: (tabId, method, params) => downloads.capture(tabId, method, params) });
  backend.contexts.set(1, "first-context"); backend.contexts.set(2, "second-context");
  backend.event({ method: "browsingContext.downloadWillBegin", params: { context: "user-context", download: "user-download", url: "https://example.test/report.pdf" } });
  backend.event({ method: "browsingContext.downloadWillBegin", params: { context: "first-context", download: "first-download", url: "https://example.test/report.pdf", suggestedFilename: "report.pdf" } });
  backend.event({ method: "browsingContext.downloadEnd", params: { context: "second-context", download: "first-download", status: "complete" } });
  backend.event({ method: "browsingContext.downloadEnd", params: { context: "first-context", download: "first-download", status: "complete", filepath: "/home/fixture/saved.pdf" } });
  assert.deepEqual(downloads.read({ sessionId: "first" }).map(event => event.status), ["started", "complete"]);
  assert.equal(downloads.read({ sessionId: "first" }).at(-1).filename, "saved.pdf");
  assert.equal(downloads.read({ sessionId: "second" }).length, 0);
});

test("missing Firefox completion support is explicitly reported without fabricated completion", async () => {
  const { downloads, start } = fixture(); start(1, "started-only");
  const handlers = new Map();
  registerDownloadHandlers({ rpc: { register: (name, handler) => handlers.set(name, handler) }, downloads, requiredSessionId: params => params.session_id, capabilities: async () => ({ started: true, completed: false }) });
  const result = await handlers.get("getDownloadEvents")({ session_id: "first" });
  assert.deepEqual(result.unsupported, ["downloads.complete"]);
  assert.equal(result.events[0].status, "started");
});

test("Firefox separately probes optional download events and preserves ordinary browsing on older versions", async () => {
  const subscriptions = [];
  class Socket {
    listeners = new Map();
    readyState = 1;
    constructor() { queueMicrotask(() => this.listeners.get("open")?.({})); }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    send(text) {
      const request = JSON.parse(text);
      const event = request.params.events?.[0];
      if (request.method === "session.subscribe") subscriptions.push(request.params.events);
      const response = request.method === "session.new"
        ? { type: "success", id: request.id, result: { sessionId: "test-session", capabilities: { browserVersion: "144.0" } } }
        : event === "browsingContext.downloadEnd"
          ? { type: "error", id: request.id, error: "invalid argument", message: "Unknown event" }
          : { type: "success", id: request.id, result: {} };
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify(response) }));
    }
    close() { this.readyState = 3; this.listeners.get("close")?.(); }
  }
  const backend = new FirefoxBackend({ endpoint: "ws://127.0.0.1:9223/session", WebSocketImpl: Socket });
  await backend.connect();
  assert.deepEqual(backend.downloadCapabilities, { started: true, completed: false });
  assert.deepEqual(subscriptions.slice(-2), [["browsingContext.downloadWillBegin"], ["browsingContext.downloadEnd"]]);
  await backend.close();
});

test("extension download delivery never uses global listeners or broadcast notifications", () => {
  const source = fs.readFileSync(new URL("../../extension-src/entrypoints/background/runtime.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /downloads\.onCreated|downloads\.onChanged|onDownloadChange/);
  assert.match(source, /registerDownloadHandlers\(/);
});

test("controlled tab access and explicit claims cannot transfer another session's tabs", () => {
  const session = { tabIds: new Set([1]), tabOrigins: new Map([[1, "agent"]]), activeTabId: 1 };
  const owner = { sessionId: "first", session, origin: "agent" };
  assert.equal(assertTabAccess({ owner, sessionId: "first", tabId: 1 }), owner);
  assert.equal(assertTabAccess({ owner, sessionId: "first", tabId: 1, allowUnowned: true }), owner);
  assert.throws(() => assertTabAccess({ owner, sessionId: "second", tabId: 1 }), /controlled by another session/);
  assert.throws(() => assertTabAccess({ owner, sessionId: "second", tabId: 1, allowUnowned: true }), /owner must release/);
  assert.throws(() => assertTabAccess({ owner: null, sessionId: "second", tabId: 99 }), /not controlled/);
  assert.equal(assertTabAccess({ owner: null, sessionId: "second", tabId: 99, allowUnowned: true }), null);
  assert.deepEqual([...session.tabIds], [1]);
  assert.equal(session.tabOrigins.get(1), "agent");
  assert.equal(session.activeTabId, 1);
});
