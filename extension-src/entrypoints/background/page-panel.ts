import type { Browser,WxtBrowser } from "wxt/browser";
import { record } from "../../../src/shared/values.ts";
import { isPagePanelUrl,pagePanelRequest,type PagePanelSnapshot,type PagePanelUsage } from "../../page-panel/protocol.ts";
import { trustedPanelSender } from "./panel-sender.ts";

interface Lease {
  instance: string; url: string; document?: string; expires: number;
  port?: Browser.runtime.Port; loading: boolean; lastRead: number; lastOpen: number; ready?: () => void;
  usage: PagePanelUsage; pending?: ReturnType<typeof setTimeout>;
  captures: number; hidden?: Promise<void>; acknowledge?: (id: string) => void;
}

export function createPagePanelRuntime(chrome: WxtBrowser, snapshot: (usage: PagePanelUsage) => Promise<PagePanelSnapshot>) {
  const leases = new Map<number, Lease>();
  const panelUrl = chrome.runtime.getURL("/popup.html");
  const forget = (tabId: number) => {
    const lease = leases.get(tabId); leases.delete(tabId);
    clearTimeout(lease?.pending); lease?.port?.disconnect();
  };
  const send = (lease: Lease, value: unknown) => { try { lease.port?.postMessage(value); } catch { lease.port = undefined; } };
  const refresh = async (tabId: number, lease: Lease) => {
    if (lease.loading || Date.now() - lease.lastRead < 1500 || leases.get(tabId) !== lease) return;
    lease.loading = true; lease.lastRead = Date.now();
    const usage = lease.usage;
    try { const data = await snapshot(usage); if (leases.get(tabId) === lease && lease.usage === usage) send(lease, { type: "snapshot", data }); }
    catch { if (leases.get(tabId) === lease) send(lease, { type: "unavailable" }); }
    finally {
      lease.loading = false;
      if (lease.usage !== usage && leases.get(tabId) === lease) {
        clearTimeout(lease.pending);
        lease.pending = setTimeout(() => { void refresh(tabId, lease); }, Math.max(0, 1500 - (Date.now() - lease.lastRead)));
      }
    }
  };
  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith("page-panel:")) return;
    const sender = port.sender, tabId = sender?.tab?.id, lease = tabId === undefined ? undefined : leases.get(tabId);
    if (!sender || tabId === undefined || !lease || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.url !== lease.url || port.name !== `page-panel:${lease.instance}` || Date.now() > lease.expires || lease.port || lease.document && sender.documentId !== lease.document) {
      port.disconnect(); return;
    }
    lease.port = port; lease.ready?.();
    port.onDisconnect.addListener(() => { clearTimeout(lease.pending); if (leases.get(tabId) === lease) leases.delete(tabId); });
    port.onMessage.addListener(value => {
      if (leases.get(tabId) !== lease) { port.disconnect(); return; }
      const parsed = pagePanelRequest.safeParse(value);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "refresh") {
        const changed = message.usage && JSON.stringify(message.usage) !== JSON.stringify(lease.usage);
        if (changed) lease.usage = message.usage!;
        if (changed && (lease.loading || Date.now() - lease.lastRead < 1500)) {
          clearTimeout(lease.pending);
          lease.pending = setTimeout(() => { if (leases.get(tabId) === lease) void refresh(tabId, lease); }, 2600);
        } else void refresh(tabId, lease);
      }
      if (message.type === "close") forget(tabId);
      if (message.type === "hidden") lease.acknowledge?.(message.id);
      if (message.type === "open") {
        // Opening a trusted page performs no mutation. Its own controls still require user input.
        if (Date.now() - lease.lastOpen < 800) return;
        lease.lastOpen = Date.now();
        void chrome.tabs.create({ url: `${panelUrl}#${message.view}` }).catch(() => send(lease, { type: "unavailable" }));
      }
    });
    void refresh(tabId, lease);
  });
  const showOnTab = async (tab: Browser.tabs.Tab | undefined) => {
    if (tab?.id === undefined || !isPagePanelUrl(tab.url)) throw new Error("Unavailable");
    const tabId = tab.id;
    forget(tabId);
    const lease: Lease = { instance: crypto.randomUUID(), url: tab.url!, expires: Date.now() + 10000, loading: false, lastRead: 0, lastOpen: 0, captures: 0, usage: { period: "7d", provider: "current" } };
    leases.set(tabId, lease);
    try {
      const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["/page-panel.js"] });
      const documentId = record(result[0]).documentId;
      if (typeof documentId === "string") lease.document = documentId;
      const current = await chrome.tabs.get(tabId);
      if (current.url !== lease.url || leases.get(tabId) !== lease) throw new Error("Navigation changed");
      let registrationTimer: ReturnType<typeof setTimeout> | undefined;
      const registered = new Promise<boolean>(resolve => { lease.ready = () => resolve(true); registrationTimer = setTimeout(() => resolve(false), 2000); });
      try {
        await chrome.tabs.sendMessage(tabId, { type: "PAGE_PANEL_SHOW", instance: lease.instance }, { frameId: 0 });
        if (!await registered) throw new Error("Panel did not register");
      } finally { clearTimeout(registrationTimer); lease.ready = undefined; }
    } catch { if (leases.get(tabId) === lease) forget(tabId); throw new Error("Unavailable"); }
  };
  chrome.action.onClicked.addListener(async tab => {
    try { await showOnTab(tab); }
    catch { await chrome.tabs.create({ url: panelUrl }); }
  });
  chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
    const message = record(value);
    if (message.type !== "PAGE_PANEL_OPEN") return false;
    if (!trustedPanelSender(sender, chrome.runtime.id, panelUrl)) { respond({ error: "pagePanelUnavailable" }); return false; }
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      await showOnTab(tab); respond({ ok: true });
    }).catch(() => respond({ error: "pagePanelUnavailable" }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(forget);
  chrome.tabs.onUpdated.addListener((tabId, changes) => { if (changes.status === "loading" || changes.url) forget(tabId); });

  async function capture<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const lease = leases.get(tabId);
    if (!lease?.port) return run();
    lease.captures++;
    try {
      if (!lease.hidden) {
        lease.hidden = new Promise<void>((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => reject(new Error("Close the on-page panel before capturing this page")), 1000);
          lease.acknowledge = received => { if (received === id) { clearTimeout(timer); resolve(); } };
          send(lease, { type: "capture", hidden: true, id });
        });
      }
      await lease.hidden;
      return await run();
    } finally {
      lease.captures--;
      if (!lease.captures) { lease.hidden = undefined; lease.acknowledge = undefined; send(lease, { type: "capture", hidden: false }); }
    }
  }
  return { capture };
}
