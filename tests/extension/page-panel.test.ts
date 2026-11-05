import { expect,test } from "bun:test";
import type { WxtBrowser } from "wxt/browser";
import { createPagePanelRuntime } from "../../extension-src/entrypoints/background/page-panel.ts";
import { trustedPanelSender } from "../../extension-src/entrypoints/background/panel-sender.ts";
import { isPagePanelUrl,pagePanelRequest,projectPagePanel } from "../../extension-src/page-panel/protocol.ts";

function event<T extends (...args: any[]) => unknown>() {
  const listeners: T[] = [];
  return { addListener: (fn: T) => listeners.push(fn), emit: (...args: Parameters<T>) => listeners.map(fn => fn(...args)) };
}
const empty = projectPagePanel(false, null, null, null);
const panelUrl = "chrome-extension://fixture/popup.html";
function fixture(options: { senderDocument?: string; senderFrame?: number; injectError?: boolean; gate?: Promise<void> } = {}) {
  const connect = event(), messages = event(), updated = event(), removed = event(), clicked = event();
  const incoming = event(), disconnected = event();
  const sent: any[] = [], opened: any[] = [];
  let instance = "", reads = 0, queried = 0;
  const queries: unknown[] = [];
  const port = {
    get name() { return `page-panel:${instance}`; },
    sender: { id: "fixture", url: "https://example.test/", frameId: options.senderFrame ?? 0, documentId: options.senderDocument ?? "document-1", tab: { id: 4, url: "https://example.test/" } },
    onMessage: incoming, onDisconnect: disconnected,
    postMessage(value: any) { sent.push(value); if (value.type === "capture" && value.hidden) queueMicrotask(() => incoming.emit({ type: "hidden", id: value.id })); },
    disconnect() { disconnected.emit(); },
  };
  const chrome = {
    action: { onClicked: clicked },
    runtime: { id: "fixture", getURL: () => panelUrl, onConnect: connect, onMessage: messages },
    tabs: {
      query: async () => { queried++; return [{ id: 4, url: "https://example.test/" }]; },
      get: async () => ({ id: 4, url: "https://example.test/" }),
      sendMessage: async (_tab: number, value: any) => { instance = value.instance; connect.emit(port); return { ok: true }; },
      create: async (value: any) => { opened.push(value); },
      onRemoved: removed, onUpdated: updated,
    },
    scripting: { executeScript: async () => { if (options.injectError) throw new Error("Denied"); return [{ frameId: 0, documentId: "document-1" }]; } },
  };
  const runtime = createPagePanelRuntime(chrome as unknown as WxtBrowser, async usage => { reads++; queries.push(usage); if (reads === 1) await options.gate; return empty; });
  const open = (sender = { id: "fixture", url: panelUrl }) => new Promise<any>(resolve => messages.emit({ type: "PAGE_PANEL_OPEN" }, sender, resolve));
  const toolbar = (url = "https://example.test/") => Promise.all(clicked.emit({ id: 4, url }));
  return { open, toolbar, sent, incoming, updated, port, opened, runtime, queries, reads: () => reads, queried: () => queried };
}

test("toolbar launches the board directly and restricted pages open trusted controls", async () => {
  const site = fixture();
  await site.toolbar();
  expect(site.reads()).toBe(1);
  expect(site.opened).toEqual([]);
  expect(site.queried()).toBe(0);
  const restricted = fixture();
  await restricted.toolbar("chrome://extensions/");
  expect(restricted.reads()).toBe(0);
  expect(restricted.opened).toEqual([{ url: panelUrl }]);
  const blocked = fixture({ injectError: true });
  await blocked.toolbar();
  expect(blocked.opened).toEqual([{ url: panelUrl }]);
});

test("page projection strips identifiers, credentials, raw native errors and invalid counters", () => {
  // Fresh non-credential data exercises projection without a hardcoded key literal.
  const raw = { apiKey: crypto.randomUUID(), profileId: "private-profile", cacheDir: "/example/private", error: "private failure" };
  const result = projectPagePanel(true,
    { ...raw, clients: [{ harness: "codex", state: "responding", id: "private-client", pid: 42 }], harnesses: [{ harness: "codex", installed: true, version: "/example/private" }] },
    { ...raw, ready: true, usage: { inputTokens: -1, outputTokens: Infinity, calls: 3, costReportedCalls: 0 } },
    { ...raw, enabled: true, counts: { actions_v2: 9, chains_v2: 2 } });
  expect(result.harnesses).toEqual([{ id: "codex", connected: true, version: null }]);
  expect(result.usage).toEqual({ input: 0, output: 0, calls: 3, cost: null, days: [] });
  expect(result.memory).toEqual({ enabled: true, actions: 9, recipes: 2 });
  const serialized = JSON.stringify(result);
  for (const privateValue of Object.values(raw)) expect(serialized).not.toContain(privateValue);
});

test("trusted panel classification excludes content scripts and embedded copies", () => {
  expect(trustedPanelSender({ id: "fixture", url: panelUrl }, "fixture", panelUrl)).toBe(true);
  expect(trustedPanelSender({ id: "fixture", url: panelUrl + "#settings", frameId: 0, tab: { id: 2, url: panelUrl } }, "fixture", panelUrl)).toBe(true);
  for (const sender of [{ id: "fixture", url: "https://example.test/", tab: { id: 2 } }, { id: "fixture", url: panelUrl, frameId: 2, tab: { id: 2, url: "https://example.test/" } }, { id: "other", url: panelUrl }, { id: "fixture" }]) expect(trustedPanelSender(sender, "fixture", panelUrl)).toBe(false);
});

test("only HTTP HTML candidates are eligible and messages cannot smuggle native operations", () => {
  expect(isPagePanelUrl("https://example.test/page")).toBe(true);
  for (const url of ["file:///example/test.html", "about:blank", "chrome://settings", panelUrl, "https://addons.mozilla.org/", "https://chromewebstore.google.com/", "https://example.test/file.PDF", "https://user:pass@example.test/"]) expect(isPagePanelUrl(url)).toBe(false);
  expect(pagePanelRequest.safeParse({ type: "open", view: "settings" }).success).toBe(true);
  for (const message of [{ type: "open", view: "settings", method: "control.update" }, { type: "open", view: "https://example.test/" }, { type: "MEMORY_CALL", method: "memory.prune" }]) expect(pagePanelRequest.safeParse(message).success).toBe(false);
});

test("website launch is rejected before tab access and injection failures return safe fallback", async () => {
  const f = fixture();
  expect(await f.open({ id: "fixture", url: "https://example.test/" })).toEqual({ error: "pagePanelUnavailable" });
  expect(f.queried()).toBe(0); expect(f.reads()).toBe(0);
  expect(await fixture({ injectError: true }).open()).toEqual({ error: "pagePanelUnavailable" });
});

test("document-bound panel refreshes bounded data and opens only a trusted view without mutating native state", async () => {
  const f = fixture(); expect(await f.open()).toEqual({ ok: true });
  await Promise.resolve(); expect(f.reads()).toBe(1);
  expect(f.sent).toContainEqual({ type: "snapshot", data: empty });
  f.incoming.emit({ type: "refresh" }); f.incoming.emit({ type: "refresh" });
  expect(f.reads()).toBe(1);
  f.incoming.emit({ type: "open", view: "settings" }); await Promise.resolve();
  expect(f.opened).toEqual([{ url: panelUrl + "#settings" }]);
  f.incoming.emit({ type: "open", view: "https://example.test/" });
  expect(f.opened).toHaveLength(1);
  f.updated.emit(4, { status: "loading" });
  f.incoming.emit({ type: "refresh" }); expect(f.reads()).toBe(1);
});

test("overlapping screenshots hide once and restore after the final capture, including failures", async () => {
  const f = fixture(); await f.open();
  let finish!: () => void;
  const pending = f.runtime.capture(4, () => new Promise<void>(resolve => { finish = resolve; }));
  const failure = f.runtime.capture(4, async () => { throw new Error("capture failed"); });
  await expect(failure).rejects.toThrow("capture failed");
  expect(f.sent.filter(row => row.type === "capture" && row.hidden)).toHaveLength(1);
  expect(f.sent.some(row => row.type === "capture" && !row.hidden)).toBe(false);
  finish(); await pending;
  expect(f.sent.filter(row => row.type === "capture" && !row.hidden)).toHaveLength(1);
});


test("filter changes coalesce to the latest bounded query instead of returning stale totals", async () => {
  const f = fixture(); await f.open();
  f.incoming.emit({ type: "refresh", usage: { period: "30d", provider: "all" } });
  f.incoming.emit({ type: "refresh", usage: { period: "last-year", provider: "openai:openai-decisions" } });
  await new Promise(resolve => setTimeout(resolve, 2700));
  expect(f.queries).toEqual([{ period: "7d", provider: "current" }, { period: "last-year", provider: "openai:openai-decisions" }]);
  f.incoming.emit({ type: "close" });
});


test("a filter changed during a pending read is refreshed after that read finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ gate }); await f.open();
  f.incoming.emit({ type: "refresh", usage: { period: "30d", provider: "all" } });
  release();
  await new Promise(resolve => setTimeout(resolve, 1600));
  expect(f.queries).toEqual([{ period: "7d", provider: "current" }, { period: "30d", provider: "all" }]);
  expect(f.sent.filter(message => message.type === "snapshot")).toHaveLength(1);
  f.incoming.emit({ type: "close" });
});


test("stale documents and child-frame registrations receive no snapshot or authority", async () => {
  const stale = fixture({ senderDocument: "stale-document" });
  const child = fixture({ senderFrame: 2 });
  const results = await Promise.all([stale.open(), child.open()]);
  expect(results).toEqual([{ error: "pagePanelUnavailable" }, { error: "pagePanelUnavailable" }]);
  expect(stale.reads()).toBe(0); expect(child.reads()).toBe(0);
  expect(stale.sent).toHaveLength(0); expect(child.sent).toHaveLength(0);
});
