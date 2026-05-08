const HOST_NAME = "com.opencode.browser";
const DEBUGGER_VERSION = "1.3";
const DEFAULT_SESSION_ID = "default";
const KEEPALIVE_ALARM = "opencode-browser-keepalive";
const SESSION_GROUP_COLOR = "green";
const DELIVERABLE_GROUP_TITLE = "✅ OpenCode";
const DELIVERABLE_GROUP_COLOR = "blue";
const MAX_CDP_EVENTS_PER_TAB = 500;

const sessions = new Map();
const attachedTabs = new Set();
const cdpEventsByTabId = new Map();
let deliverableGroupId = null;

const hostStatus = {
  state: "disconnected",
  hostName: HOST_NAME,
  error: null,
  lastChecked: null,
  reconnectAttempt: 0,
};

class NativeRpc {
  #handlers = new Map();
  #nextId = 1;
  #pending = new Map();
  #port = null;
  #reconnectTimer = null;

  register(method, handler) {
    this.#handlers.set(method, handler);
  }

  connect() {
    if (this.#port) return;

    try {
      this.#port = chrome.runtime.connectNative(HOST_NAME);
      hostStatus.state = "connected";
      hostStatus.error = null;
      hostStatus.lastChecked = new Date().toISOString();

      this.#port.onMessage.addListener((message) => {
        void this.#handleMessage(message);
      });

      this.#port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        hostStatus.state = "disconnected";
        hostStatus.error = error?.message ?? null;
        hostStatus.lastChecked = new Date().toISOString();
        this.#port = null;
        this.#rejectPending(error?.message ?? "Native host disconnected");
        this.#scheduleReconnect();
      });
    } catch (error) {
      hostStatus.state = "disconnected";
      hostStatus.error = error instanceof Error ? error.message : String(error);
      hostStatus.lastChecked = new Date().toISOString();
      this.#scheduleReconnect();
    }
  }

  async notify(method, params) {
    try {
      this.#post({ jsonrpc: "2.0", method, params });
    } catch {
      this.connect();
    }
  }

  async request(method, params) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#post({ jsonrpc: "2.0", method, params, id });
    return promise;
  }

  #post(message) {
    if (!this.#port) throw new Error("Native host is not connected");
    this.#port.postMessage(message);
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) return;
    hostStatus.reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  #rejectPending(message) {
    for (const pending of this.#pending.values()) pending.reject(new Error(message));
    this.#pending.clear();
  }

  async #handleMessage(message) {
    if (message?.method) {
      await this.#handleRequest(message);
      return;
    }

    if (message?.id !== undefined) this.#handleResponse(message);
  }

  #handleResponse(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);

    if (message.error) pending.reject(new Error(message.error.message ?? "RPC error"));
    else pending.resolve(message.result);
  }

  async #handleRequest(message) {
    const handler = this.#handlers.get(message.method);
    if (!handler) {
      if (message.id !== undefined) {
        this.#post({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
      }
      return;
    }

    try {
      const result = await handler(message.params ?? {});
      if (message.id !== undefined) this.#post({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) {
        this.#post({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
}

const rpc = new NativeRpc();

function sessionId(params) {
  return params.session_id ?? params.sessionId ?? DEFAULT_SESSION_ID;
}

function sessionState(id) {
  let session = sessions.get(id);
  if (!session) {
    session = { tabIds: new Set(), name: null, groupId: null };
    sessions.set(id, session);
  }
  return session;
}

async function trackTab(id, tabId) {
  sessionState(id).tabIds.add(tabId);
  await ensureSessionGroup(id, tabId).catch(() => {});
}

function tabIdFromParams(params) {
  const tabId = params.tabId ?? params.tab_id ?? params.target?.tabId;
  if (!Number.isInteger(tabId)) throw new Error("Expected numeric tabId");
  return tabId;
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    title: tab.title ?? null,
    url: tab.url ?? null,
    active: Boolean(tab.active),
    windowId: tab.windowId,
    index: tab.index,
  };
}

function normalizeKeepItem(item) {
  if (Number.isInteger(item)) return { tabId: item, status: "handoff" };
  return {
    tabId: item?.tabId ?? item?.tab_id,
    status: item?.status ?? "handoff",
  };
}

function cdpEventTabId(source) {
  return Number.isInteger(source?.tabId) ? source.tabId : null;
}

function recordCdpEvent(source, method, params) {
  const tabId = cdpEventTabId(source);
  if (!Number.isInteger(tabId)) return;
  const events = cdpEventsByTabId.get(tabId) ?? [];
  events.push({
    time: new Date().toISOString(),
    tabId,
    method,
    params: params ?? {},
  });
  if (events.length > MAX_CDP_EVENTS_PER_TAB) events.splice(0, events.length - MAX_CDP_EVENTS_PER_TAB);
  cdpEventsByTabId.set(tabId, events);
}

function chromeCall(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function getTab(tabId) {
  return chromeCall((done) => chrome.tabs.get(tabId, done));
}

async function activateTab(tabId) {
  const tab = await getTab(tabId);
  if (Number.isInteger(tab.windowId)) {
    await chromeCall((done) => chrome.windows.update(tab.windowId, { focused: true }, done)).catch(() => {});
  }
  await chromeCall((done) => chrome.tabs.update(tabId, { active: true }, done)).catch(() => {});
  return getTab(tabId);
}

async function ensureSessionGroup(id, tabId) {
  const session = sessionState(id);
  if (!chrome.tabs.group || !chrome.tabGroups) return null;

  if (Number.isInteger(session.groupId)) {
    try {
      await chromeCall((done) => chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId }, done));
      return session.groupId;
    } catch {
      session.groupId = null;
    }
  }

  const groupId = await chromeCall((done) => chrome.tabs.group({ tabIds: [tabId] }, done));
  session.groupId = groupId;
  await chromeCall((done) => {
    chrome.tabGroups.update(
      groupId,
      { title: session.name ?? "OpenCode", color: SESSION_GROUP_COLOR },
      done,
    );
  }).catch(() => {});
  return groupId;
}

async function ensureDeliverableGroup(tabId) {
  if (!chrome.tabs.group || !chrome.tabGroups) return null;

  if (Number.isInteger(deliverableGroupId)) {
    try {
      await chromeCall((done) => chrome.tabs.group({ tabIds: [tabId], groupId: deliverableGroupId }, done));
      return deliverableGroupId;
    } catch {
      deliverableGroupId = null;
    }
  }

  const groupId = await chromeCall((done) => chrome.tabs.group({ tabIds: [tabId] }, done));
  deliverableGroupId = groupId;
  await chromeCall((done) => {
    chrome.tabGroups.update(
      groupId,
      { title: DELIVERABLE_GROUP_TITLE, color: DELIVERABLE_GROUP_COLOR },
      done,
    );
  }).catch(() => {});
  return groupId;
}

async function injectCursor(tabId) {
  if (!chrome.scripting?.executeScript) return;
  await chromeCall((done) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content-scripts/cursor.js"] },
      done,
    );
  }).catch(() => {});
}

async function moveMouse(params) {
  const tabId = tabIdFromParams(params);
  await activateTab(tabId);
  await injectCursor(tabId);
  await chromeCall((done) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: "OPENCODE_CURSOR_STATE",
        x: params.x,
        y: params.y,
        visible: params.visible !== false,
      },
      done,
    );
  }).catch(() => {});
  return {};
}

async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chromeCall((done) => chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, done));
  attachedTabs.add(tabId);
}

async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  await chromeCall((done) => chrome.debugger.detach({ tabId }, done));
  attachedTabs.delete(tabId);
}

async function executeCdp(params) {
  const tabId = tabIdFromParams(params);
  const method = params.method;
  if (typeof method !== "string" || method.length === 0) throw new Error("Expected CDP method");

  if (method === "Target.getTargets") {
    const targets = await chromeCall((done) => chrome.debugger.getTargets(done));
    return { targetInfos: targets };
  }

  await attachTab(tabId);
  return chromeCall((done) => {
    chrome.debugger.sendCommand(
      { tabId },
      method,
      params.commandParams ?? params.command_params ?? {},
      done,
    );
  });
}

rpc.register("ping", async () => "pong");

rpc.register("getInfo", async () => ({
  name: "OpenCode Browser",
  version: chrome.runtime.getManifest().version,
  type: "extension",
  metadata: {
    extensionId: chrome.runtime.id,
    hostName: HOST_NAME,
  },
}));

rpc.register("attach", async (params) => {
  await attachTab(tabIdFromParams(params));
  return {};
});

rpc.register("detach", async (params) => {
  await detachTab(tabIdFromParams(params));
  return {};
});

rpc.register("executeCdp", executeCdp);

rpc.register("activateTab", async (params) => normalizeTab(await activateTab(tabIdFromParams(params))));

rpc.register("moveMouse", moveMouse);

rpc.register("getCdpEvents", async (params) => {
  const tabId = tabIdFromParams(params);
  const methods = Array.isArray(params.methods) ? new Set(params.methods) : null;
  const prefix = typeof params.methodPrefix === "string" ? params.methodPrefix : null;
  const limit = Number.isInteger(params.limit) ? params.limit : 100;
  let events = cdpEventsByTabId.get(tabId) ?? [];
  if (methods) events = events.filter((event) => methods.has(event.method));
  if (prefix) events = events.filter((event) => event.method.startsWith(prefix));
  return { events: events.slice(-limit) };
});

rpc.register("clearCdpEvents", async (params) => {
  cdpEventsByTabId.delete(tabIdFromParams(params));
  return {};
});

rpc.register("createTab", async (params) => {
  const id = sessionId(params);
  const tab = await chromeCall((done) => chrome.tabs.create({ active: true, url: "about:blank" }, done));
  await trackTab(id, tab.id);
  return normalizeTab(tab);
});

rpc.register("claimUserTab", async (params) => {
  const id = sessionId(params);
  const tabId = tabIdFromParams(params);
  const tab = await getTab(tabId);
  await trackTab(id, tabId);
  return normalizeTab(tab);
});

rpc.register("getTabs", async (params) => {
  const session = sessionState(sessionId(params));
  const tabs = [];
  for (const tabId of session.tabIds) {
    try {
      tabs.push(normalizeTab(await getTab(tabId)));
    } catch {
      session.tabIds.delete(tabId);
    }
  }
  return { tabs };
});

rpc.register("getUserTabs", async () => {
  const tabs = await chromeCall((done) => chrome.tabs.query({}, done));
  return { tabs: tabs.map(normalizeTab) };
});

rpc.register("getUserHistory", async (params) => {
  const items = await chromeCall((done) => {
    chrome.history.search(
      {
        text: params.query ?? "",
        maxResults: params.limit ?? 25,
        startTime: params.from ? Date.parse(params.from) : 0,
        endTime: params.to ? Date.parse(params.to) : Date.now(),
      },
      done,
    );
  });
  return { items };
});

rpc.register("finalizeTabs", async (params) => {
  const keep = new Map((params.keep ?? []).map((item) => {
    const normalized = normalizeKeepItem(item);
    return [normalized.tabId, normalized.status];
  }));
  const session = sessionState(sessionId(params));
  for (const tabId of [...session.tabIds]) {
    if (keep.has(tabId)) {
      if (keep.get(tabId) === "deliverable") await ensureDeliverableGroup(tabId).catch(() => {});
      continue;
    }
    await chromeCall((done) => chrome.tabs.remove(tabId, done)).catch(() => {});
    session.tabIds.delete(tabId);
    attachedTabs.delete(tabId);
  }
  return {};
});

rpc.register("nameSession", async (params) => {
  const session = sessionState(sessionId(params));
  session.name = typeof params.name === "string" ? params.name : null;
  if (Number.isInteger(session.groupId) && chrome.tabGroups) {
    await chromeCall((done) => {
      chrome.tabGroups.update(
        session.groupId,
        { title: session.name ?? "OpenCode", color: SESSION_GROUP_COLOR },
        done,
      );
    }).catch(() => {});
  }
  return {};
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  recordCdpEvent(source, method, params);
  void rpc.notify("onCDPEvent", { source, method, params }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_HOST_STATUS") return false;
  sendResponse({ status: hostStatus });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  rpc.connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  rpc.connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) rpc.connect();
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
rpc.connect();
