// Browser.downloadWillBegin can be global even when delivered on a page's
// connection. Page events (or the verified BiDi bridge) establish tab identity.
const START_METHODS = new Set(["Page.downloadWillBegin"]);
const PROGRESS_METHODS = new Set(["Page.downloadProgress", "Browser.downloadProgress"]);
const TERMINAL_STATUSES = new Set(["complete", "canceled", "failed"]);

function safeUrl(value) {
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

function basename(value) {
  if (typeof value !== "string") return null;
  return [...(value.split(/[\\/]/).at(-1) ?? "")].filter(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join("").slice(0, 255) || null;
}

function byteCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// DownloadItem events have no trustworthy originating tab. Only protocol events
// delivered by a controlled tab establish provenance; progress keeps that owner.
export function createDownloadEvents({ ownerForTab, clock = () => new Date().toISOString(), maxEvents = 200, maxDownloads = 1000, maxSessions = 100 } = {}) {
  const bySession = new Map();
  const downloads = new Map();

  function ownedBy(tabId, sessionId) {
    return ownerForTab(tabId) === sessionId;
  }

  function record(download, patch) {
    const event = { ...download.event, ...patch, time: clock() };
    download.event = event;
    const events = bySession.get(download.sessionId) ?? [];
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    bySession.set(download.sessionId, events);
    if (bySession.size > maxSessions) {
      const oldest = bySession.keys().next().value;
      bySession.delete(oldest);
      for (const [id, item] of downloads) if (item.sessionId === oldest) downloads.delete(id);
    }
    return event;
  }

  function start(tabId, id, event) {
    if (!Number.isInteger(tabId) || typeof id !== "string" || !id || id.length > 512 || downloads.has(id)) return null;
    const sessionId = ownerForTab(tabId);
    if (typeof sessionId !== "string" || !sessionId) return null;
    const download = { sessionId, tabId, event: {
      id, tabId, source: "browser", status: event.status ?? "started",
      url: safeUrl(event.url), finalUrl: safeUrl(event.finalUrl ?? event.url),
      filename: basename(event.filename), mime: typeof event.mime === "string" ? event.mime.slice(0, 200) : null,
      totalBytes: byteCount(event.totalBytes), bytesReceived: byteCount(event.bytesReceived), danger: null, error: null,
    } };
    downloads.set(id, download);
    if (downloads.size > maxDownloads) downloads.delete(downloads.keys().next().value);
    return record(download, {});
  }

  function capture(tabId, method, params = {}) {
    if (START_METHODS.has(method)) {
      return start(tabId, params.guid, { url: params.url, filename: params.suggestedFilename });
    }
    if (!PROGRESS_METHODS.has(method)) return null;
    const download = downloads.get(params.guid);
    if (!download || download.tabId !== tabId || TERMINAL_STATUSES.has(download.event.status)) return null;
    const status = { inProgress: "in_progress", completed: "complete", canceled: "canceled" }[params.state];
    if (!status) return null;
    return record(download, {
      status,
      totalBytes: byteCount(params.totalBytes) ?? download.event.totalBytes,
      bytesReceived: byteCount(params.receivedBytes) ?? download.event.bytesReceived,
      filename: basename(params.filePath) ?? download.event.filename,
    });
  }

  function scope(sessionId, tabId) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Expected session_id");
    if (tabId !== undefined && (!Number.isInteger(tabId) || !ownedBy(tabId, sessionId))) throw new Error("Download tab is not controlled by this session");
    return event => (tabId === undefined || event.tabId === tabId) && ownedBy(event.tabId, sessionId);
  }

  return {
    capture,
    recordInline(tabId, id, event) { return start(tabId, id, { ...event, status: "opened_inline" }); },
    read({ sessionId, tabId, limit = 100 }) {
      const matches = scope(sessionId, tabId);
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, maxEvents)) : 100;
      return (bySession.get(sessionId) ?? []).filter(matches).slice(-boundedLimit).map(event => ({ ...event }));
    },
    clear({ sessionId, tabId }) {
      const matches = scope(sessionId, tabId);
      // Keep provenance so progress after clearing cannot be claimed by another
      // session or resurrect a start through a duplicate protocol notification.
      const events = bySession.get(sessionId);
      if (events) bySession.set(sessionId, events.filter(event => !matches(event)));
    },
  };
}

export function registerDownloadHandlers({ rpc, downloads, requiredSessionId, capabilities }) {
  function options(params) {
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
