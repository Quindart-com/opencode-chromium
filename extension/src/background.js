const HOST_NAME = "com.opencode.browser";
const DEBUGGER_VERSION = "1.3";
const KEEPALIVE_ALARM = "opencode-browser-keepalive";
const HEARTBEAT_ALARM = "opencode-browser-heartbeat";
const SESSION_GROUP_COLOR = "green";
const DELIVERABLE_GROUP_TITLE = "OpenCode Deliverables";
const DELIVERABLE_GROUP_COLOR = "blue";
const MAX_CDP_EVENTS_PER_TAB = 500;
const MAX_DOWNLOAD_EVENTS = 200;
const MAX_INLINE_RESPONSE_KEYS = 500;
const DEFAULT_CDP_TIMEOUT_MS = 10000;
const DEFAULT_NATIVE_REQUEST_TIMEOUT_MS = 15000;
const HOST_STATUS_STORAGE_KEY = "OPENCODE_NATIVE_HOST_STATUS";
const SESSIONS_STORAGE_KEY = "OPENCODE_BROWSER_SESSIONS";

const sessions = new Map();
const attachedTabs = new Map();
const tabLocks = new Map();
const cdpEventsByTabId = new Map();
const cursorStateByTabId = new Map();
const cursorArrivalWaiters = new Map();
const cursorInjectedTabs = new Set();
const downloadEvents = [];
const inlineResponseEventKeys = new Set();
let deliverableGroupId = null;

const hostStatus = {
  state: "disconnected",
  hostName: HOST_NAME,
  error: null,
  lastChecked: null,
  reconnectAttempt: 0,
  nextRetryMs: null,
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
      this.#setStatus({ state: "connected", error: null, nextRetryMs: null });

      this.#port.onMessage.addListener((message) => {
        void this.#handleMessage(message);
      });

      this.#port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        this.#port = null;
        this.#rejectPending(error?.message ?? "Native host disconnected");
        this.#setStatus({ state: "disconnected", error: error?.message ?? null });
        this.#scheduleReconnect();
      });
    } catch (error) {
      this.#setStatus({ state: "disconnected", error: errorMessage(error) });
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

  async request(method, params, options = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_NATIVE_REQUEST_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Native host request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try {
      this.#post({ jsonrpc: "2.0", method, params, id });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.#pending.delete(id);
      throw error;
    }
    return promise;
  }

  heartbeat() {
    if (!this.#port) {
      this.connect();
      return;
    }

    this.request("ping", { time: nowIso() }).catch((error) => {
      this.#setStatus({ state: "disconnected", error: errorMessage(error) });
      this.#rejectPending("Native host heartbeat failed");
      this.#port?.disconnect();
      this.#port = null;
      this.#scheduleReconnect();
    });
  }

  #post(message) {
    if (!this.#port) throw new Error("Native host is not connected");
    this.#port.postMessage(message);
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) return;
    hostStatus.reconnectAttempt += 1;
    hostStatus.nextRetryMs = 1000;
    this.#setStatus({ state: "reconnecting" });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, hostStatus.nextRetryMs);
  }

  #setStatus(patch) {
    Object.assign(hostStatus, patch, { lastChecked: nowIso() });
    void storageSet({ [HOST_STATUS_STORAGE_KEY]: hostStatus }).catch(() => {});
  }

  #rejectPending(message) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
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
    clearTimeout(pending.timeout);

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
            message: errorMessage(error),
          },
        });
      }
    }
  }
}

const rpc = new NativeRpc();

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function requiredSessionId(params) {
  const id = params.session_id ?? params.sessionId;
  if (typeof id !== "string" || id.length === 0) throw new Error("Expected session_id");
  return id;
}

function turnId(params) {
  const id = params.turn_id ?? params.turnId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function sessionState(id) {
  let session = sessions.get(id);
  if (!session) {
    session = {
      tabIds: new Set(),
      tabOrigins: new Map(),
      name: null,
      groupId: null,
      activeTabId: null,
      currentTurnId: null,
    };
    sessions.set(id, session);
  }
  return session;
}

function updateTurn(session, params) {
  const id = turnId(params);
  if (id) session.currentTurnId = id;
}

function findTabOwner(tabId) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.tabIds.has(tabId)) {
      return { sessionId, session, origin: session.tabOrigins.get(tabId) ?? "agent" };
    }
  }
  return null;
}

function ensureControlledTab(params, tabId) {
  const sessionId = requiredSessionId(params);
  const session = sessionState(sessionId);
  updateTurn(session, params);
  if (!session.tabIds.has(tabId)) throw new Error(`Tab ${tabId} is not controlled by this session`);
  return { sessionId, session, origin: session.tabOrigins.get(tabId) ?? "agent" };
}

function tabIdFromParams(params) {
  const tabId = params.tabId ?? params.tab_id ?? params.target?.tabId;
  if (!Number.isInteger(tabId)) throw new Error("Expected numeric tabId");
  return tabId;
}

function cursorIdFromParams(params) {
  const id = params.cursorId ?? params.cursor_id ?? params.session_id ?? params.sessionId;
  return typeof id === "string" && id.length > 0 ? id : "default";
}

function cursorStatesForTab(tabId) {
  let states = cursorStateByTabId.get(tabId);
  if (!states) {
    states = new Map();
    cursorStateByTabId.set(tabId, states);
  }
  return states;
}

function currentCursorStates(tabId) {
  return [...(cursorStateByTabId.get(tabId)?.values() ?? [])];
}

function normalizeKeepItem(item) {
  const tabId = Number.isInteger(item) ? item : item?.tabId ?? item?.tab_id ?? item?.tab?.id;
  const status = Number.isInteger(item) ? "handoff" : item?.status ?? "handoff";
  if (!Number.isInteger(tabId)) throw new Error("Expected keep item tabId");
  if (status !== "handoff" && status !== "deliverable") throw new Error(`Unsupported keep status: ${status}`);
  return { tabId, status };
}

function isBrowserInternalUrl(url) {
  return /^(chrome|edge|brave|vivaldi|opera|chrome-extension):\/\//i.test(url ?? "");
}

function normalizeTab(tab, extra = {}) {
  const owner = Number.isInteger(tab.id) ? findTabOwner(tab.id) : null;
  return {
    id: tab.id,
    title: tab.title ?? null,
    url: tab.url ?? null,
    active: Boolean(tab.active),
    windowId: tab.windowId,
    index: tab.index,
    lastOpened: Number.isFinite(tab.lastAccessed) ? new Date(tab.lastAccessed).toISOString() : null,
    controlled: Boolean(owner),
    sessionId: owner?.sessionId ?? null,
    origin: owner?.origin ?? null,
    ...extra,
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
    time: nowIso(),
    tabId,
    method,
    params: params ?? {},
  });
  if (events.length > MAX_CDP_EVENTS_PER_TAB) events.splice(0, events.length - MAX_CDP_EVENTS_PER_TAB);
  cdpEventsByTabId.set(tabId, events);
  recordInlineBrowserResponse(tabId, method, params);
}

function chromeCall(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageGet(key) {
  return chromeCall((done) => chrome.storage.local.get(key, done));
}

function storageSet(value) {
  return chromeCall((done) => chrome.storage.local.set(value, done));
}

async function persistSessions() {
  const serialized = {};
  for (const [id, session] of sessions.entries()) {
    serialized[id] = {
      tabIds: [...session.tabIds],
      tabOrigins: Object.fromEntries(session.tabOrigins.entries()),
      name: session.name,
      groupId: session.groupId,
      activeTabId: session.activeTabId,
      currentTurnId: session.currentTurnId,
    };
  }
  await storageSet({ [SESSIONS_STORAGE_KEY]: serialized });
}

async function restoreSessions() {
  const stored = (await storageGet(SESSIONS_STORAGE_KEY).catch(() => ({})))?.[SESSIONS_STORAGE_KEY];
  if (!stored || typeof stored !== "object") return;

  for (const [id, serialized] of Object.entries(stored)) {
    const session = sessionState(id);
    session.name = typeof serialized.name === "string" ? serialized.name : null;
    session.groupId = Number.isInteger(serialized.groupId) ? serialized.groupId : null;
    session.activeTabId = Number.isInteger(serialized.activeTabId) ? serialized.activeTabId : null;
    session.currentTurnId = typeof serialized.currentTurnId === "string" ? serialized.currentTurnId : null;

    const origins = serialized.tabOrigins && typeof serialized.tabOrigins === "object" ? serialized.tabOrigins : {};
    for (const tabId of serialized.tabIds ?? []) {
      if (!Number.isInteger(tabId)) continue;
      try {
        await getTab(tabId);
        session.tabIds.add(tabId);
        session.tabOrigins.set(tabId, origins[tabId] === "user" ? "user" : "agent");
      } catch {
        // Drop stale persisted tabs.
      }
    }

    if (!session.tabIds.size) sessions.delete(id);
  }
}

async function getTab(tabId) {
  return chromeCall((done) => chrome.tabs.get(tabId, done));
}

async function queryTabs(queryInfo) {
  return chromeCall((done) => chrome.tabs.query(queryInfo, done));
}

async function focusTab(tabId, options = {}) {
  const tab = await getTab(tabId);
  if (!options.foreground) return tab;
  if (Number.isInteger(tab.windowId)) {
    await chromeCall((done) => chrome.windows.update(tab.windowId, { focused: true }, done)).catch(() => {});
  }
  await chromeCall((done) => chrome.tabs.update(tabId, { active: true }, done)).catch(() => {});
  return getTab(tabId);
}

async function focusedNormalWindowId() {
  const windows = await chromeCall((done) => chrome.windows.getAll({ windowTypes: ["normal"] }, done)).catch(() => []);
  return (windows.find((window) => window.focused) ?? windows[0])?.id ?? null;
}

async function groupTitle(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chromeCall((done) => chrome.tabGroups.get(groupId, done)).catch(() => null);
  return group?.title ?? null;
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
  await persistSessions().catch(() => {});
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

async function ungroupTab(tabId) {
  if (!chrome.tabs.ungroup) return;
  await chromeCall((done) => chrome.tabs.ungroup(tabId, done)).catch(() => {});
}

async function trackTab(sessionId, tabId, origin) {
  const existing = findTabOwner(tabId);
  if (existing && existing.sessionId !== sessionId) {
    throw new Error(`Tab ${tabId} already belongs to another browser session`);
  }

  const session = sessionState(sessionId);
  session.tabIds.add(tabId);
  session.tabOrigins.set(tabId, origin);
  session.activeTabId = tabId;
  await ensureSessionGroup(sessionId, tabId).catch(() => {});
  await persistSessions().catch(() => {});
}

async function untrackTab(sessionId, tabId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.tabIds.delete(tabId);
  session.tabOrigins.delete(tabId);
  if (session.activeTabId === tabId) session.activeTabId = [...session.tabIds].at(-1) ?? null;
  if (!session.tabIds.size) sessions.delete(sessionId);
  cdpEventsByTabId.delete(tabId);
  cursorStateByTabId.delete(tabId);
  cursorInjectedTabs.delete(tabId);
  await persistSessions().catch(() => {});
}

async function injectCursor(tabId, options = {}) {
  if (!chrome.scripting?.executeScript) return false;
  if (!options.force && cursorInjectedTabs.has(tabId)) return true;
  try {
    await chromeCall((done) => {
      chrome.scripting.executeScript(
        { target: { tabId }, files: ["content-scripts/cursor.js"], injectImmediately: true },
        done,
      );
    });
    cursorInjectedTabs.add(tabId);
    return true;
  } catch {
    cursorInjectedTabs.delete(tabId);
    return false;
  }
}

function cursorWaiterKey(tabId, cursorId, moveSequence) {
  return `${tabId}:${cursorId}:${moveSequence}`;
}

async function waitForCursorArrival(tabId, cursorId, moveSequence, timeoutMs) {
  const key = cursorWaiterKey(tabId, cursorId, moveSequence);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cursorArrivalWaiters.delete(key);
      resolve({ arrived: false, timedOut: true });
    }, timeoutMs);
    cursorArrivalWaiters.set(key, () => {
      clearTimeout(timer);
      cursorArrivalWaiters.delete(key);
      resolve({ arrived: true, timedOut: false });
    });
  });
}

async function publishCursorState(tabId, state) {
  const cursorId = state.cursorId ?? "default";
  cursorStatesForTab(tabId).set(cursorId, { ...state, cursorId });
  if (!(await injectCursor(tabId))) throw new Error(`Could not inject cursor overlay into tab ${tabId}`);
  try {
    const response = await chromeCall((done) => {
      chrome.tabs.sendMessage(tabId, { type: "OPENCODE_CURSOR_STATE", ...state, cursorId }, done);
    });
    return { delivered: true, retried: false, response };
  } catch (error) {
    cursorInjectedTabs.delete(tabId);
  }

  if (await injectCursor(tabId, { force: true })) {
    const response = await chromeCall((done) => {
      chrome.tabs.sendMessage(tabId, { type: "OPENCODE_CURSOR_STATE", ...state, cursorId }, done);
    });
    return { delivered: true, retried: true, response };
  }

  throw new Error(`Could not deliver cursor state to tab ${tabId}`);
}

async function moveMouse(params) {
  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);

  const cursorId = cursorIdFromParams(params);
  const previous = cursorStateByTabId.get(tabId)?.get(cursorId);
  const moveSequence = Number.isInteger(params.moveSequence)
    ? params.moveSequence
    : (previous?.moveSequence ?? 0) + 1;
  const x = finiteNumber(params.x, "x");
  const y = finiteNumber(params.y, "y");
  const state = {
    x,
    y,
    visible: params.visible !== false,
    moveSequence,
    cursorId,
    imageUrl: chrome.runtime.getURL("images/cursor-chat.png"),
  };

  const arrival = params.waitForArrival
    ? waitForCursorArrival(tabId, cursorId, moveSequence, params.timeoutMs ?? 2000)
    : null;
  const delivery = await publishCursorState(tabId, state);
  if (arrival) {
    const result = await arrival;
    if (result.timedOut) throw new Error(`Cursor did not report arrival within ${params.timeoutMs ?? 2000}ms`);
    return { ...result, ...delivery };
  }
  return { moveSequence, cursorId, ...delivery };
}

async function hideCursor(tabId, cursorId) {
  const states = cursorStateByTabId.get(tabId);
  const ids = cursorId ? [cursorId] : [...(states?.keys() ?? ["default"] )];
  for (const id of ids) {
    const previous = states?.get(id) ?? { x: -100, y: -100, moveSequence: 0, cursorId: id };
    await publishCursorState(tabId, { ...previous, cursorId: id, visible: false, moveSequence: previous.moveSequence + 1 });
  }
}

async function withTabLock(tabId, operation) {
  const previous = tabLocks.get(tabId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stored = previous.catch(() => {}).then(() => gate);
  tabLocks.set(tabId, stored);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (tabLocks.get(tabId) === stored) tabLocks.delete(tabId);
  }
}

async function attachTab(tabId, sessionId) {
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) return {};
    try {
      await chromeCall((done) => chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, done));
    } catch (error) {
      if (/another debugger/i.test(errorMessage(error))) {
        throw new Error(`Cannot attach debugger to tab ${tabId}: another debugger is already attached`);
      }
      throw error;
    }
    attachedTabs.set(tabId, sessionId);
    return {};
  });
}

async function detachTab(tabId) {
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) return {};
    await chromeCall((done) => chrome.debugger.detach({ tabId }, done)).catch(() => {});
    attachedTabs.delete(tabId);
    return {};
  });
}

function commandTimeoutMs(params) {
  const timeoutMs = params.timeoutMs ?? params.timeout_ms ?? DEFAULT_CDP_TIMEOUT_MS;
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CDP_TIMEOUT_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendCdpCommand(tabId, method, commandParams, timeoutMs) {
  let timeoutId;
  let settled = false;
  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      void detachTab(tabId);
      reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);

    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result ?? {});
    });
  });
}

async function executeCdp(params) {
  const method = params.method;
  if (typeof method !== "string" || method.length === 0) throw new Error("Expected CDP method");

  if (method === "Target.getTargets") {
    const targets = await chromeCall((done) => chrome.debugger.getTargets(done));
    return { targetInfos: targets };
  }

  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);
  if (!attachedTabs.has(tabId)) throw new Error("Debugger unattached");

  return withTabLock(tabId, () => sendCdpCommand(
    tabId,
    method,
    params.commandParams ?? params.command_params ?? {},
    commandTimeoutMs(params),
  ));
}

async function executeInputGesture(params) {
  const tabId = tabIdFromParams(params);
  const methodTimeoutMs = commandTimeoutMs(params);
  const { sessionId } = ensureControlledTab(params, tabId);
  const cursorId = cursorIdFromParams(params);
  const steps = Array.isArray(params.steps) ? params.steps : [];
  if (!steps.length) throw new Error("inputGesture requires at least one step");
  if (steps.length > 5000) throw new Error(`inputGesture step limit exceeded: ${steps.length}`);

  for (const [index, step] of steps.entries()) {
    if (step.cursor) {
      finiteNumber(step.cursor.x, `steps[${index}].cursor.x`);
      finiteNumber(step.cursor.y, `steps[${index}].cursor.y`);
    }
    const params = step.commandParams ?? step.command_params;
    if (params && (step.method === "Input.dispatchMouseEvent" || step.method === "Input.dispatchTouchEvent")) {
      if (params.x !== undefined) finiteNumber(params.x, `steps[${index}].commandParams.x`);
      if (params.y !== undefined) finiteNumber(params.y, `steps[${index}].commandParams.y`);
    }
  }

  await attachTab(tabId, sessionId);
  let moveSequence = cursorStateByTabId.get(tabId)?.get(cursorId)?.moveSequence ?? 0;

  return withTabLock(tabId, async () => {
    const results = [];
    const hasCursorSteps = steps.some((s) => s.cursor && Number.isFinite(s.cursor.x) && Number.isFinite(s.cursor.y));
    const cursorPublishInterval = hasCursorSteps && steps.length > 20 ? Math.max(1, Math.floor(steps.length / 20)) : 1;
    let stepIndex = 0;

    for (const step of steps) {
      stepIndex += 1;
      const isLast = stepIndex === steps.length;
      if (step.cursor && Number.isFinite(step.cursor.x) && Number.isFinite(step.cursor.y)) {
        moveSequence += 1;
        if (isLast || stepIndex % cursorPublishInterval === 1) {
          await publishCursorState(tabId, {
            x: Number(step.cursor.x),
            y: Number(step.cursor.y),
            visible: step.cursor.visible !== false,
            moveSequence,
            cursorId,
            imageUrl: chrome.runtime.getURL("images/cursor-chat.png"),
          });
        } else {
          cursorStatesForTab(tabId).set(cursorId, {
            x: Number(step.cursor.x),
            y: Number(step.cursor.y),
            visible: step.cursor.visible !== false,
            moveSequence,
            cursorId,
            imageUrl: chrome.runtime.getURL("images/cursor-chat.png"),
          });
        }
      }

      if (typeof step.method === "string" && step.method.length > 0) {
        results.push(await sendCdpCommand(
          tabId,
          step.method,
          step.commandParams ?? step.command_params ?? {},
          Number.isFinite(step.timeoutMs) && step.timeoutMs > 0 ? step.timeoutMs : methodTimeoutMs,
        ));
      }

      const delayMs = Number(step.delayMs ?? step.delay_ms ?? 0);
      if (delayMs > 0) await sleep(Math.min(delayMs, 1000));
    }
    return { results, cursorId, moveSequence };
  });
}

function recordDownloadEvent(event) {
  const normalized = { time: nowIso(), ...event };
  downloadEvents.push(normalized);
  if (downloadEvents.length > MAX_DOWNLOAD_EVENTS) downloadEvents.splice(0, downloadEvents.length - MAX_DOWNLOAD_EVENTS);
  void rpc.notify("onDownloadChange", normalized).catch(() => {});
}

function normalizeDownloadItem(item, status) {
  return {
    id: item.id,
    status,
    url: item.url ?? null,
    finalUrl: item.finalUrl ?? null,
    filename: item.filename ?? null,
    mime: item.mime ?? null,
    totalBytes: item.totalBytes ?? null,
    bytesReceived: item.bytesReceived ?? null,
    danger: item.danger ?? null,
    error: item.error ?? null,
  };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function filenameFromDisposition(disposition) {
  if (typeof disposition !== "string") return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

function recordInlineBrowserResponse(tabId, method, params) {
  if (method !== "Network.responseReceived") return;
  const response = params?.response;
  const mime = String(response?.mimeType ?? headerValue(response?.headers, "content-type") ?? "").toLowerCase();
  if (!mime.includes("application/pdf")) return;

  const url = response?.url ?? params?.documentURL ?? null;
  const key = `${tabId}:${params?.requestId ?? url ?? inlineResponseEventKeys.size}`;
  if (inlineResponseEventKeys.has(key)) return;
  inlineResponseEventKeys.add(key);
  if (inlineResponseEventKeys.size > MAX_INLINE_RESPONSE_KEYS) inlineResponseEventKeys.delete(inlineResponseEventKeys.values().next().value);

  const totalBytes = Number(headerValue(response?.headers, "content-length"));
  recordDownloadEvent({
    id: `inline:${key}`,
    status: "opened_inline",
    source: "browser",
    tabId,
    url,
    finalUrl: url,
    filename: filenameFromDisposition(headerValue(response?.headers, "content-disposition")),
    mime: response?.mimeType ?? "application/pdf",
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    bytesReceived: null,
    danger: null,
    error: null,
  });
}

function registerDownloadListeners() {
  if (!chrome.downloads?.onCreated || !chrome.downloads?.onChanged) return;

  chrome.downloads.onCreated.addListener((item) => {
    recordDownloadEvent(normalizeDownloadItem(item, "started"));
  });

  chrome.downloads.onChanged.addListener((delta) => {
    let status = "in_progress";
    if (delta.state?.current === "complete") status = "complete";
    if (delta.state?.current === "interrupted") status = delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    recordDownloadEvent({
      id: delta.id,
      status,
      filename: delta.filename?.current ?? null,
      error: delta.error?.current ?? null,
      bytesReceived: delta.bytesReceived?.current ?? null,
      totalBytes: delta.totalBytes?.current ?? null,
      delta,
    });
  });
}

rpc.register("ping", async () => "pong");

rpc.register("getInfo", async () => ({
  id: chrome.runtime.id,
  name: "OpenCode Browser",
  version: chrome.runtime.getManifest().version,
  type: "extension",
  capabilities: {
    browser: [
      { id: "tabs", description: "Create, claim, list, finalize, and navigate Chromium tabs." },
      { id: "history", description: "Read browser history through the extension history permission." },
      { id: "downloads", description: "Observe browser download lifecycle events." },
    ],
    tab: [
      { id: "cdp", description: "Run Chrome DevTools Protocol commands against controlled tabs." },
      { id: "cua", description: "Coordinate-based mouse, keyboard, scroll, drag, and screenshot automation." },
      { id: "dom", description: "DOM snapshot and selector-based interaction helpers." },
      { id: "clipboard", description: "Read and write plain text through the page clipboard API." },
    ],
  },
  metadata: {
    extensionId: chrome.runtime.id,
    hostName: HOST_NAME,
  },
}));

rpc.register("attach", async (params) => {
  const tabId = tabIdFromParams(params);
  const { sessionId } = ensureControlledTab(params, tabId);
  return attachTab(tabId, sessionId);
});

rpc.register("detach", async (params) => detachTab(tabIdFromParams(params)));

rpc.register("executeCdp", executeCdp);

rpc.register("inputGesture", executeInputGesture);

rpc.register("activateTab", async (params) => {
  const tabId = tabIdFromParams(params);
  const { session } = ensureControlledTab(params, tabId);
  session.activeTabId = tabId;
  await persistSessions().catch(() => {});
  return normalizeTab(await focusTab(tabId, { foreground: params.foreground === true }));
});

rpc.register("moveMouse", moveMouse);

rpc.register("notifyCursorArrived", async (params) => {
  const tabId = tabIdFromParams(params);
  const cursorId = cursorIdFromParams(params);
  const moveSequence = params.moveSequence ?? params.move_sequence;
  const waiter = cursorArrivalWaiters.get(cursorWaiterKey(tabId, cursorId, moveSequence));
  if (waiter) waiter();
  return {};
});

rpc.register("getCdpEvents", async (params) => {
  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);
  const methods = Array.isArray(params.methods) ? new Set(params.methods) : null;
  const prefix = typeof params.methodPrefix === "string" ? params.methodPrefix : null;
  const limit = Number.isInteger(params.limit) ? params.limit : 100;
  let events = cdpEventsByTabId.get(tabId) ?? [];
  if (methods) events = events.filter((event) => methods.has(event.method));
  if (prefix) events = events.filter((event) => event.method.startsWith(prefix));
  return { events: events.slice(-limit) };
});

rpc.register("clearCdpEvents", async (params) => {
  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);
  cdpEventsByTabId.delete(tabId);
  return {};
});

rpc.register("createTab", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  updateTurn(session, params);
  const windowId = await focusedNormalWindowId();
  let tab;
  if (Number.isInteger(windowId)) {
    tab = await chromeCall((done) => chrome.tabs.create({ active: false, url: "about:blank", windowId }, done));
  } else {
    const window = await chromeCall((done) => chrome.windows.create({ focused: false, type: "normal", url: "about:blank" }, done));
    tab = window.tabs?.[0];
    if (!tab?.id) throw new Error("Could not create browser tab");
  }
  await trackTab(id, tab.id, "agent");
  return normalizeTab(tab);
});

rpc.register("claimUserTab", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  updateTurn(session, params);
  const tabId = tabIdFromParams(params);
  const tab = await getTab(tabId);
  if (isBrowserInternalUrl(tab.url)) throw new Error(`Cannot claim internal browser tab: ${tab.url}`);
  await trackTab(id, tabId, "user");
  return normalizeTab(tab);
});

rpc.register("getTabs", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  updateTurn(session, params);
  const tabs = [];
  for (const tabId of [...session.tabIds]) {
    try {
      const tab = await getTab(tabId);
      if (isBrowserInternalUrl(tab.url)) continue;
      tabs.push(normalizeTab(tab, {
        selected: session.activeTabId === tabId,
        origin: session.tabOrigins.get(tabId) ?? "agent",
      }));
    } catch {
      await untrackTab(id, tabId);
    }
  }
  return { tabs };
});

rpc.register("getSelectedTab", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  updateTurn(session, params);
  if (!Number.isInteger(session.activeTabId) || !session.tabIds.has(session.activeTabId)) return null;
  try {
    return normalizeTab(await getTab(session.activeTabId), { selected: true });
  } catch {
    await untrackTab(id, session.activeTabId);
    return null;
  }
});

rpc.register("getTab", async (params) => {
  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);
  return normalizeTab(await getTab(tabId));
});

rpc.register("getUserTabs", async () => {
  const tabs = await queryTabs({});
  const groupTitles = new Map();
  const normalized = [];
  for (const tab of tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 1000)) {
    let tabGroup = null;
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
      if (!groupTitles.has(tab.groupId)) groupTitles.set(tab.groupId, await groupTitle(tab.groupId));
      tabGroup = groupTitles.get(tab.groupId);
    }
    normalized.push(normalizeTab(tab, { tabGroup, claimable: !isBrowserInternalUrl(tab.url) }));
  }
  return { tabs: normalized };
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
  return {
    items: items.map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title ?? null,
      dateVisited: Number.isFinite(item.lastVisitTime) ? new Date(item.lastVisitTime).toISOString() : null,
      visitCount: item.visitCount ?? null,
      typedCount: item.typedCount ?? null,
    })),
  };
});

rpc.register("closeTab", async (params) => {
  const tabId = tabIdFromParams(params);
  const { sessionId } = ensureControlledTab(params, tabId);
  await detachTab(tabId);
  await chromeCall((done) => chrome.tabs.remove(tabId, done));
  await untrackTab(sessionId, tabId);
  return {};
});

rpc.register("reloadTab", async (params) => {
  const tabId = tabIdFromParams(params);
  ensureControlledTab(params, tabId);
  await chromeCall((done) => chrome.tabs.reload(tabId, { bypassCache: Boolean(params.bypassCache) }, done));
  return {};
});

rpc.register("finalizeTabs", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  updateTurn(session, params);
  const keep = new Map((params.keep ?? []).map((item) => {
    const normalized = normalizeKeepItem(item);
    if (!session.tabIds.has(normalized.tabId)) throw new Error(`Cannot keep unmanaged tab ${normalized.tabId}`);
    return [normalized.tabId, normalized.status];
  }));

  for (const tabId of [...session.tabIds]) {
    const status = keep.get(tabId);
    const origin = session.tabOrigins.get(tabId) ?? "agent";
    await detachTab(tabId);
    await hideCursor(tabId).catch(() => {});

    if (status) {
      if (status === "deliverable") {
        await ensureDeliverableGroup(tabId).catch(() => {});
      }
      await untrackTab(id, tabId);
      continue;
    }

    if (origin === "user") {
      await ungroupTab(tabId);
      await untrackTab(id, tabId);
      continue;
    }

    await chromeCall((done) => chrome.tabs.remove(tabId, done));
    await untrackTab(id, tabId);
  }
  await persistSessions().catch(() => {});
  return {};
});

rpc.register("turnEnded", async (params) => {
  const id = requiredSessionId(params);
  const session = sessionState(id);
  for (const tabId of [...session.tabIds]) {
    await detachTab(tabId);
    await hideCursor(tabId).catch(() => {});
  }
  session.currentTurnId = null;
  await persistSessions().catch(() => {});
  return {};
});

rpc.register("nameSession", async (params) => {
  const session = sessionState(requiredSessionId(params));
  updateTurn(session, params);
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
  await persistSessions().catch(() => {});
  return {};
});

rpc.register("getDownloadEvents", async (params) => {
  const limit = Number.isInteger(params.limit) ? params.limit : 100;
  return { events: downloadEvents.slice(-limit) };
});

rpc.register("clearDownloadEvents", async () => {
  downloadEvents.splice(0, downloadEvents.length);
  return {};
});

rpc.register("executeUnhandledCommand", async (params) => ({ handled: false, command: params.command ?? null }));

chrome.debugger.onEvent.addListener((source, method, params) => {
  recordCdpEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  cdpEventsByTabId.delete(tabId);
  cursorStateByTabId.delete(tabId);
  cursorInjectedTabs.delete(tabId);
  const owner = findTabOwner(tabId);
  if (owner) void untrackTab(owner.sessionId, tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") cursorInjectedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_HOST_STATUS" || message?.type === "GET_NATIVE_HOST_STATUS") {
    sendResponse({ status: hostStatus });
    return true;
  }

  if (message?.type === "OPENCODE_CURSOR_ARRIVED") {
    const tabId = sender.tab?.id;
    const cursorId = typeof message.cursorId === "string" && message.cursorId.length > 0 ? message.cursorId : "default";
    const moveSequence = message.moveSequence;
    if (Number.isInteger(tabId)) {
      const waiter = cursorArrivalWaiters.get(cursorWaiterKey(tabId, cursorId, moveSequence));
      if (waiter) waiter();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "OPENCODE_GET_CURSOR_STATE") {
    const tabId = sender.tab?.id;
    const states = Number.isInteger(tabId) ? currentCursorStates(tabId) : [];
    sendResponse({ state: states[0] ?? null, states });
    return true;
  }

  return false;
});

function createAlarms() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  createAlarms();
  rpc.connect();
});

chrome.runtime.onStartup.addListener(() => {
  createAlarms();
  void restoreSessions().catch(() => {});
  rpc.connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) rpc.connect();
  if (alarm.name === HEARTBEAT_ALARM) rpc.heartbeat();
});

registerDownloadListeners();
createAlarms();
void restoreSessions().catch(() => {});
rpc.connect();
