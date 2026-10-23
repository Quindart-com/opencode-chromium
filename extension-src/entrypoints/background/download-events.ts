import type { CommandParams } from "./command-schema.ts";
import type { NativeRpc } from "./native-rpc.ts";

export interface DownloadEvent {
  id: string;
  tabId: number;
  source: "browser";
  status: string;
  url: string | null;
  finalUrl: string | null;
  filename: string | null;
  mime: string | null;
  totalBytes: number | null;
  bytesReceived: number | null;
  danger: null;
  error: null;
  time: string;
}
type DownloadInput = Partial<Record<"url" | "finalUrl" | "filename" | "mime" | "totalBytes" | "bytesReceived" | "danger" | "error", unknown>> & { status?: string };
type DownloadRecord = { sessionId: string; tabId: number; event: DownloadEvent };
type DownloadScope = { sessionId: string; tabId?: number; limit?: number };

// Browser.downloadWillBegin can be global even when delivered on a page's
// connection. Page events (or the verified BiDi bridge) establish tab identity.
const START_METHODS = new Set(["Page.downloadWillBegin"]);
const PROGRESS_METHODS = new Set(["Page.downloadProgress", "Browser.downloadProgress"]);
const TERMINAL_STATUSES = new Set(["complete", "canceled", "failed"]);

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!/^(https?:|blob:)$/.test(url.protocol)) return null;
    if (url.protocol === "blob:") {
      const originUrl = new URL(url.pathname);
      if (!/^https?:$/.test(originUrl.protocol)) return null;
      originUrl.username = ""; originUrl.password = ""; originUrl.search = ""; originUrl.hash = "";
      return `blob:${originUrl.href}`;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function basename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return [...(value.split(/[\\/]/).at(-1) ?? "")].filter(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join("").slice(0, 255) || null;
}

function byteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// DownloadItem events have no trustworthy originating tab. Only protocol events
// delivered by a controlled tab establish provenance; progress keeps that owner.
export function createDownloadEvents({ ownerForTab, clock = () => new Date().toISOString(), maxEvents = 200, maxDownloads = 1000, maxSessions = 100 }: {
  ownerForTab(tabId: number): string | null;
  clock?: () => string;
  maxEvents?: number;
  maxDownloads?: number;
  maxSessions?: number;
}) {
  const bySession = new Map<string, DownloadEvent[]>();
  const downloads = new Map<string, DownloadRecord>();

  function ownedBy(tabId: number, sessionId: string) {
    return ownerForTab(tabId) === sessionId;
  }

  function record(download: DownloadRecord, patch: Partial<DownloadEvent>) {
    const event = { ...download.event, ...patch, time: clock() };
    download.event = event;
    const events = bySession.get(download.sessionId) ?? [];
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    bySession.set(download.sessionId, events);
    if (bySession.size > maxSessions) {
      const oldest = bySession.keys().next().value;
      if (oldest !== undefined) bySession.delete(oldest);
      for (const [id, item] of downloads) if (item.sessionId === oldest) downloads.delete(id);
    }
    return event;
  }

  function start(tabId: number, id: unknown, event: DownloadInput) {
    if (!Number.isInteger(tabId) || typeof id !== "string" || !id || id.length > 512 || downloads.has(id)) return null;
    const sessionId = ownerForTab(tabId);
    if (typeof sessionId !== "string" || !sessionId) return null;
    const download: DownloadRecord = { sessionId, tabId, event: {
      id, tabId, source: "browser", status: event.status ?? "started",
      url: safeUrl(event.url), finalUrl: safeUrl(event.finalUrl ?? event.url),
      filename: basename(event.filename), mime: typeof event.mime === "string" ? event.mime.slice(0, 200) : null,
      totalBytes: byteCount(event.totalBytes), bytesReceived: byteCount(event.bytesReceived), danger: null, error: null, time: clock(),
    } };
    downloads.set(id, download);
    const oldest = downloads.keys().next().value;
    if (downloads.size > maxDownloads && oldest !== undefined) downloads.delete(oldest);
    return record(download, {});
  }

  function capture(tabId: number, method: string, params: Record<string, unknown> = {}) {
    if (START_METHODS.has(method)) {
      return start(tabId, params.guid, { url: params.url, filename: params.suggestedFilename });
    }
    if (!PROGRESS_METHODS.has(method)) return null;
    const download = typeof params.guid === "string" ? downloads.get(params.guid) : undefined;
    if (!download || download.tabId !== tabId || TERMINAL_STATUSES.has(download.event.status)) return null;
    const states: Readonly<Record<string, string>> = { inProgress: "in_progress", completed: "complete", canceled: "canceled" };
    const status = typeof params.state === "string" ? states[params.state] : undefined;
    if (!status) return null;
    return record(download, {
      status,
      totalBytes: byteCount(params.totalBytes) ?? download.event.totalBytes,
      bytesReceived: byteCount(params.receivedBytes) ?? download.event.bytesReceived,
      filename: basename(params.filePath) ?? download.event.filename,
    });
  }

  function scope(sessionId: string, tabId?: number) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Expected session_id");
    if (tabId !== undefined && (!Number.isInteger(tabId) || !ownedBy(tabId, sessionId))) throw new Error("Download tab is not controlled by this session");
    return (event: DownloadEvent) => (tabId === undefined || event.tabId === tabId) && ownedBy(event.tabId, sessionId);
  }

  return {
    capture,
    recordInline(tabId: number, id: string, event: DownloadInput) { return start(tabId, id, { ...event, status: "opened_inline" }); },
    read({ sessionId, tabId, limit = 100 }: DownloadScope) {
      const matches = scope(sessionId, tabId);
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, maxEvents)) : 100;
      return (bySession.get(sessionId) ?? []).filter(matches).slice(-boundedLimit).map(event => ({ ...event }));
    },
    clear({ sessionId, tabId }: DownloadScope) {
      const matches = scope(sessionId, tabId);
      // Keep provenance so progress after clearing cannot be claimed by another
      // session or resurrect a start through a duplicate protocol notification.
      const events = bySession.get(sessionId);
      if (events) bySession.set(sessionId, events.filter(event => !matches(event)));
    },
  };
}

export function registerDownloadHandlers({ rpc, downloads, requiredSessionId, capabilities }: {
  rpc: Pick<NativeRpc, "register">;
  downloads: ReturnType<typeof createDownloadEvents>;
  requiredSessionId(params: CommandParams): string;
  capabilities?: (() => Promise<{ started: boolean; completed: boolean }>) | null;
}) {
  function options(params: CommandParams): DownloadScope {
    return { sessionId: requiredSessionId(params), tabId: params.tabId ?? params.tab_id, limit: params.limit };
  }
  rpc.register("getDownloadEvents", async params => {
    const events = downloads.read(options(params));
    if (!capabilities) return { events };
    const supported = await capabilities();
    const unsupported = [!supported.started && "downloads.started", !supported.completed && "downloads.complete"].filter(Boolean);
    return { events, ...(unsupported.length ? { unsupported, message: "This browser does not report the corresponding attributed download events; update Firefox for full download lifecycle support." } : {}) };
  });
  rpc.register("clearDownloadEvents", async params => { downloads.clear(options(params)); return {}; });
}
