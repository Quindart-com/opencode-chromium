import type { Browser } from "wxt/browser";
import { browser as chrome } from "wxt/browser";
import { z } from "zod/mini";
import type { CdpMethod,CdpParams,CdpResult } from "../../../src/shared/cdp.ts";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import { partialDispatchError } from "../../../src/shared/execution-state.ts";
import { record } from "../../../src/shared/values.ts";
import type { VersionStatus } from "../../version-status.ts";
import { CommandHealth } from "./command-health.ts";
import type { CommandParams,KeepItem } from "./command-schema.ts";
import type { CursorState } from "./cursor-state.ts";
import { cursorIdFromParams,gestureAction } from "./cursor-state.ts";
import { createDebuggerAttacher,installChromiumEvents } from "./debugger-attach.ts";
import { createDownloadEvents } from "./download-events.ts";
import { createFirefoxAttacher } from "./firefox-bridge.ts";
import { FirefoxFrameRouting } from "./firefox-frame-routing.ts";
import { resolveTabActivation } from "./focus-policy.ts";
import { FrameRouting } from "./frame-routing.ts";
import { createInlineResponseRecorder } from "./inline-response-recorder.ts";
import { NativeRpc } from "./native-rpc.ts";
import { assertSessionUrl,installNavigationPolicy,updateSessionPolicy } from "./navigation-policy.ts";
import { openInstallGuide } from "./onboarding.ts";
import { createCdpRuntime } from "./runtime-cdp.ts";
import { createCursorRuntime } from "./runtime-cursor.ts";
import { registerRuntimeMethods } from "./runtime-methods.ts";
import { createPopupRuntime } from "./runtime-popup.ts";
import { createProfileRuntime } from "./runtime-profile.ts";
import { assertClaimableTab,assertTabAccess,isBrowserInternalUrl,isClaimableTab } from "./tab-ownership.ts";
import type { ExtensionSession,TabOwner,TraceBuffer } from "./types.ts";
import { createUploadConsent } from "./upload-consent.ts";
import { guardedCdp,uploadTargetUrl } from "./upload-gate.ts";
type CdpEvent = {
    time: string;
    tabId: number;
    method: string;
    params: Record<string, unknown>;
};
type HostStatus = VersionStatus & {
    hostName: string;
    error: string | null;
    lastChecked: string | null;
    reconnectAttempt: number;
    nextRetryMs: number | null;
};
const uploadInfoSchema = z.object({ token: z.string(), files: z.array(z.object({ name: z.string(), size: z.number(), preview: z.optional(z.string()), path: z.string() })) });
const HOST_NAME = "com.opencode.browser.plugin";
const IS_FIREFOX = import.meta.env.BROWSER === "firefox";
const DEBUGGER_VERSION = "1.3";
const KEEPALIVE_ALARM = "opencode-browser-plugin-keepalive";
const HEARTBEAT_ALARM = "opencode-browser-plugin-heartbeat";
const SESSION_GROUP_COLOR = "green";
const MAX_CDP_EVENTS_PER_TAB = 500;
const MAX_DOWNLOAD_EVENTS = 200;
const MAX_TRACE_CHUNKS = 80000;
const MAX_INLINE_RESPONSE_KEYS = 500;
const DEFAULT_CDP_TIMEOUT_MS = 10000;
const DEFAULT_NATIVE_REQUEST_TIMEOUT_MS = 15000;
const HOST_STATUS_STORAGE_KEY = "OPENCODE_NATIVE_HOST_STATUS";
const SESSIONS_STORAGE_KEY = "OPENCODE_BROWSER_SESSIONS";
const PROFILE_STORAGE_KEY = "OPENCODE_BROWSER_PROFILE";
const VERSION_REMINDER_KEY = "OPENCODE_VERSION_REMINDER";
const versionCheck = { generation: 0 };
let reconciliationToken: string | null = null;
let restoringSessions = 0;
const sessions = new Map<string, ExtensionSession>();
const attachedTabs = new Map<number, string>();
const commandHealth = new CommandHealth();
const creationRequestIds = new Map<number, string>();
const firefoxFrameRouting = new FirefoxFrameRouting((tabId, method, params, timeoutMs) => sendCdpCommand(tabId, method, params, timeoutMs));
const frameRouting = new FrameRouting((tabId, method, params, timeoutMs, sessionId) => sendCdpCommand(tabId, method, params, timeoutMs, sessionId));
const cdpEventsByTabId = new Map<number, CdpEvent[]>();
const traceBuffers = new Map<number, TraceBuffer>();
const cursorStateByTabId = new Map<number, Map<string, CursorState>>();
const cursorArrivalWaiters = new Map<string, () => void>();
const cursorInjectedTabs = new Set<number>();
const downloadEvents = createDownloadEvents({ ownerForTab: tabId => findTabOwner(tabId)?.sessionId ?? null, maxEvents: MAX_DOWNLOAD_EVENTS });
const inlineResponseEventKeys = new Set<string>();
const hostStatus: HostStatus = {
    state: "disconnected",
    hostName: HOST_NAME,
    error: null,
    lastChecked: null,
    reconnectAttempt: 0,
    nextRetryMs: null,
    versionChecked: false,
    nativeHostVersion: null,
    clientVersions: [],
    versionReminder: null,
};
const rpc = new NativeRpc({ chrome, hostName: HOST_NAME, timeoutMs: DEFAULT_NATIVE_REQUEST_TIMEOUT_MS,
    status(patch) {
        if (patch.state === "reconnecting")
            hostStatus.reconnectAttempt += 1;
        Object.assign(hostStatus, patch, { lastChecked: nowIso() });
        void storageSet({ [HOST_STATUS_STORAGE_KEY]: hostStatus }).catch(() => { });
        broadcastNativeStatus();
    },
    connected() { ++versionCheck.generation; void announceProfile().catch(() => { }); },
    disconnected() { ++versionCheck.generation; reconciliationToken = null; },
});
const uploadConsent = createUploadConsent({ chrome,
    describe: async (files) => uploadInfoSchema.parse(await rpc.request("uploads.describe", { files }, { timeoutMs: 60000 })),
    snapshot: async (token) => z.object({ files: z.array(z.string()) }).parse(await rpc.request("uploads.snapshot", { token }, { timeoutMs: 60000 })),
    release: token => rpc.request("uploads.release", { token }),
});
function nowIso() {
    return new Date().toISOString();
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
let popupRuntime: ReturnType<typeof createPopupRuntime> | null = null;
function broadcastNativeStatus() { popupRuntime?.broadcastNativeStatus(); }
const profileRuntime = createProfileRuntime({ rpc, chrome, IS_FIREFOX, PROFILE_STORAGE_KEY, VERSION_REMINDER_KEY, hostStatus, storageGet, storageSet, broadcastNativeStatus, versionCheck,
    acceptReconciliationToken(value: unknown) { const token = record(value).reconciliationToken; reconciliationToken = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : null; } });
const { setProfileLabel, profileMetadata, publicProfile, sanitizeSemanticForPopup, announceProfile, updateVersionBadge } = profileRuntime;
const connectionIdle = () => restoringSessions === 0 && ![...sessions.values()].some(session => session.tabIds.size > 0) && attachedTabs.size === 0 && commandHealth.idle() && traceBuffers.size === 0;
rpc.register("runtime.canReconnect", async () => ({ idle: rpc.idle() && connectionIdle() }));
function finiteNumber(value: unknown, label: string): number {
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new Error(`${label} must be a finite number`);
    return number;
}
function requiredSessionId(params: CommandParams): string {
    const id = params.session_id ?? params.sessionId;
    if (typeof id !== "string" || id.length === 0)
        throw new Error("Expected session_id");
    return id;
}
function turnId(params: CommandParams): string | null {
    const id = params.turn_id ?? params.turnId;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function sessionState(id: string): ExtensionSession {
    let session = sessions.get(id);
    if (!session) {
        session = {
            tabIds: new Set(),
            tabOrigins: new Map(),
            lastActivityAt: Date.now(),
            name: null,
            groupId: null,
            activeTabId: null,
            currentTurnId: null,
        };
        sessions.set(id, session);
    }
    return session;
}
function updateTurn(session: ExtensionSession, params: CommandParams) {
    session.lastActivityAt = Date.now();
    updateSessionPolicy(session, params);
    const id = turnId(params);
    if (id)
        session.currentTurnId = id;
}
function findTabOwner(tabId: number): TabOwner | null {
    for (const [sessionId, session] of sessions.entries()) {
        if (session.tabIds.has(tabId)) {
            return { sessionId, session, origin: session.tabOrigins.get(tabId) ?? "agent" };
        }
    }
    return null;
}
function ensureControlledTab(params: CommandParams, tabId: number): TabOwner {
    const sessionId = requiredSessionId(params);
    assertTabAccess({ owner: findTabOwner(tabId), sessionId, tabId });
    const session = sessionState(sessionId);
    updateTurn(session, params);
    session.activeTabId = tabId;
    void persistSessions().catch(() => { });
    return { sessionId, session, origin: session.tabOrigins.get(tabId) ?? "agent" };
}
function tabIdFromParams(params: CommandParams): number {
    const tabId = params.tabId ?? params.tab_id ?? params.target?.tabId;
    if (typeof tabId !== "number" || !Number.isInteger(tabId))
        throw new Error("Expected numeric tabId");
    return tabId;
}
function cursorStatesForTab(tabId: number): Map<string, CursorState> {
    let states = cursorStateByTabId.get(tabId);
    if (!states) {
        states = new Map();
        cursorStateByTabId.set(tabId, states);
    }
    return states;
}
function currentCursorStates(tabId: number): CursorState[] {
    return [...(cursorStateByTabId.get(tabId)?.values() ?? [])];
}
function normalizeKeepItem(item: KeepItem): {
    tabId: number;
    status: "handoff" | "deliverable";
} {
    const tabId = typeof item === "number" ? item : item.tabId ?? item.tab_id ?? item.tab?.id;
    const status = typeof item === "number" ? "deliverable" : item.status ?? "deliverable";
    if (typeof tabId !== "number" || !Number.isInteger(tabId))
        throw new Error("Expected keep item tabId");
    if (status !== "handoff" && status !== "deliverable")
        throw new Error(`Unsupported keep status: ${status}`);
    return { tabId, status };
}
function normalizeTab<T extends object>(tab: Browser.tabs.Tab, extra: T = {} as T) {
    const owner = tab.id !== undefined && Number.isInteger(tab.id) ? findTabOwner(tab.id) : null;
    return {
        ...(tab.id !== undefined && creationRequestIds.has(tab.id) ? { creationRequestId: creationRequestIds.get(tab.id) } : {}),
        id: tab.id,
        title: tab.title ?? null,
        url: tab.url ?? null,
        active: Boolean(tab.active),
        windowId: tab.windowId,
        index: tab.index,
        lastOpened: typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed) ? new Date(tab.lastAccessed).toISOString() : null,
        controlled: Boolean(owner),
        sessionId: owner?.sessionId ?? null,
        ...extra,
    };
}
function cdpEventTabId(source: Browser.debugger.Debuggee): number | null {
    return source.tabId !== undefined && Number.isInteger(source.tabId) ? source.tabId : null;
}
function recordCdpEvent(source: Browser.debugger.Debuggee, method: string, params: object | undefined) {
    const tabId = cdpEventTabId(source);
    if (tabId === null || !Number.isInteger(tabId) || !attachedTabs.has(tabId))
        return;
    if (/^(?:Page|Browser)\.download(?:WillBegin|Progress)$/.test(method)) {
        downloadEvents.capture(tabId, method, record(params));
        return;
    }
    const childSessionId = record(source).sessionId;
    commandHealth.event(tabId, method, record(params), typeof childSessionId === "string" ? childSessionId : undefined);
    const events = cdpEventsByTabId.get(tabId) ?? [];
    events.push({
        time: nowIso(),
        tabId,
        method,
        params: record(params),
    });
    if (events.length > MAX_CDP_EVENTS_PER_TAB)
        events.splice(0, events.length - MAX_CDP_EVENTS_PER_TAB);
    cdpEventsByTabId.set(tabId, events);
    recordInlineBrowserResponse(tabId, method, params);
}
function chromeCall<T = void>(fn: (done: (result: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        try {
            fn((result) => {
                const error = chrome.runtime.lastError;
                if (error)
                    reject(new Error(error.message));
                else
                    resolve(result);
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
function storageGet(key: string): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(key);
}
function storageSet(value: Record<string, unknown>) {
    return chrome.storage.local.set(value);
}
async function persistSessions() {
    const serialized: Record<string, unknown> = {};
    for (const [id, session] of sessions.entries()) {
        serialized[id] = {
            tabIds: [...session.tabIds],
            tabOrigins: Object.fromEntries(session.tabOrigins.entries()),
            lastActivityAt: session.lastActivityAt,
            name: session.name,
            urlPolicy: session.urlPolicy ?? null,
            groupId: session.groupId,
            activeTabId: session.activeTabId,
            currentTurnId: session.currentTurnId,
        };
    }
    await storageSet({ [SESSIONS_STORAGE_KEY]: serialized });
}
async function restoreSessions() {
    restoringSessions++;
    try {
    const stored = (await storageGet(SESSIONS_STORAGE_KEY).catch((): Record<string, unknown> => ({})))?.[SESSIONS_STORAGE_KEY];
    if (!stored || typeof stored !== "object")
        return;
    for (const [id, value] of Object.entries(stored)) {
        const parsed = z.object({ name: z.optional(z.nullable(z.string())), urlPolicy: z.optional(z.nullable(z.object({ allowedOrigins: z.optional(z.array(z.string())), blockedOrigins: z.optional(z.array(z.string())) }))), groupId: z.optional(z.nullable(z.int())), activeTabId: z.optional(z.nullable(z.int())), currentTurnId: z.optional(z.nullable(z.string())), lastActivityAt: z.optional(z.number()), tabOrigins: z.optional(z.record(z.string(), z.string())), tabIds: z.optional(z.array(z.int())) }).safeParse(value);
        if (!parsed.success)
            continue;
        const serialized = parsed.data;
        const session = sessionState(id);
        session.lastActivityAt = typeof serialized.lastActivityAt === "number" && Number.isFinite(serialized.lastActivityAt) ? serialized.lastActivityAt : 0;
        session.name = typeof serialized.name === "string" ? serialized.name : null;
        if (serialized.urlPolicy)
            updateSessionPolicy(session, { url_policy: serialized.urlPolicy });
        session.groupId = typeof serialized.groupId === "number" && Number.isInteger(serialized.groupId) ? serialized.groupId : null;
        session.activeTabId = typeof serialized.activeTabId === "number" && Number.isInteger(serialized.activeTabId) ? serialized.activeTabId : null;
        session.currentTurnId = typeof serialized.currentTurnId === "string" ? serialized.currentTurnId : null;
        const origins = serialized.tabOrigins && typeof serialized.tabOrigins === "object" ? serialized.tabOrigins : {};
        for (const tabId of serialized.tabIds ?? []) {
            if (!Number.isInteger(tabId))
                continue;
            try {
                await getTab(tabId);
                session.tabIds.add(tabId);
                session.tabOrigins.set(tabId, origins[tabId] === "user" ? "user" : "agent");
            }
            catch {
                // Drop stale persisted tabs.
            }
        }
        if (!session.tabIds.size)
            sessions.delete(id);
    }
    } finally { restoringSessions--; }
}
async function getTab(tabId: number) {
    return chrome.tabs.get(tabId);
}
async function queryTabs(queryInfo: Browser.tabs.QueryInfo) {
    return chrome.tabs.query(queryInfo);
}
async function focusTab(tabId: number, options: {
    active?: boolean;
    foreground?: boolean;
} = {}) {
    const tab = await getTab(tabId);
    if (options.active === true) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => { });
    }
    if (options.foreground && Number.isInteger(tab.windowId)) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { });
    }
    return getTab(tabId);
}
async function focusedNormalWindowId() {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
    return (windows.find((window) => window.focused) ?? windows[0])?.id ?? null;
}
async function ensureSessionGroup(id: string, tabId: number) {
    const session = sessionState(id);
    if (!chrome.tabs.group || !chrome.tabGroups)
        return null;
    if (session.groupId !== null && Number.isInteger(session.groupId)) {
        try {
            await chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId });
            return session.groupId;
        }
        catch {
            session.groupId = null;
        }
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    session.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title: session.name ?? "OpenCode", color: SESSION_GROUP_COLOR }).catch(() => { });
    await persistSessions().catch(() => { });
    return groupId;
}
async function ungroupTab(tabId: number) {
    if (!chrome.tabs.ungroup)
        return;
    await chrome.tabs.ungroup(tabId).catch(() => { });
}
async function trackTab(sessionId: string, tabId: number, origin: string) {
    const existing = findTabOwner(tabId);
    assertTabAccess({ owner: existing, sessionId, tabId, allowUnowned: true });
    const session = sessionState(sessionId);
    session.tabIds.add(tabId);
    session.tabOrigins.set(tabId, existing?.origin ?? origin);
    session.activeTabId = tabId;
    await ensureSessionGroup(sessionId, tabId).catch(() => { });
    await persistSessions().catch(() => { });
}
async function untrackTab(sessionId: string, tabId: number) {
    const session = sessions.get(sessionId);
    if (!session)
        return;
    creationRequestIds.delete(tabId);
    session.tabIds.delete(tabId);
    session.tabOrigins.delete(tabId);
    if (session.activeTabId === tabId)
        session.activeTabId = [...session.tabIds].at(-1) ?? null;
    if (!session.tabIds.size)
        sessions.delete(sessionId);
    cdpEventsByTabId.delete(tabId);
    traceBuffers.delete(tabId);
    cursorStateByTabId.delete(tabId);
    cursorInjectedTabs.delete(tabId);
    await persistSessions().catch(() => { });
}
const { cursorWaiterKey, publishCursorState, framePoint, moveMouse, hideCursor } = createCursorRuntime({ chrome, cursorInjectedTabs, cursorArrivalWaiters, cursorStatesForTab, tabIdFromParams, ensureControlledTab, IS_FIREFOX, firefoxFrameRouting, frameRouting, assertSessionUrl, cursorStateByTabId, finiteNumber });
const withTabLock = <T>(tabId: number, operation: () => Promise<T>, deadlineAt?: number, method?: string) => commandHealth.run(tabId, operation, deadlineAt, method);
const attachChromiumTab = createDebuggerAttacher({ withTabLock, attachedTabs, isBrowserInternalUrl, getTab, chromeCall, chrome, DEBUGGER_VERSION, errorMessage, sendCdpCommand, DEFAULT_CDP_TIMEOUT_MS, onAttached: (tabId, deadlineAt) => frameRouting.enable(tabId, undefined, deadlineAt).catch(() => {}), generation: tabId => commandHealth.generation(tabId), trackPending: (tabId, task) => commandHealth.track(tabId, task), keepAttached: tabId => Boolean(commandHealth.dialog(tabId)) });
const attachTab = IS_FIREFOX ? createFirefoxAttacher({ withTabLock, getTab, isBrowserInternalUrl, attachedTabs, chromeCall, chrome, rpc, generation: tabId => commandHealth.generation(tabId), trackPending: (tabId, task) => commandHealth.track(tabId, task) }) : attachChromiumTab;
async function detachTab(tabId: number) {
    commandHealth.invalidate(tabId);
    const epoch = commandHealth.generation(tabId);
    const task = (async () => {
        if (!attachedTabs.has(tabId))
            return {};
        if (IS_FIREFOX)
            await rpc.request("firefox.detach", { tabId }, { timeoutMs: 3000 });
        else
            await chrome.debugger.detach({ tabId });
        if (IS_FIREFOX)
            await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (globalThis.__opencodeFileGuard)
                    document.removeEventListener("click", globalThis.__opencodeFileGuard, true); delete globalThis.__opencodeFileGuard; } }).catch(() => { });
        if (epoch === commandHealth.generation(tabId)) {
            attachedTabs.delete(tabId);
            frameRouting.forget(tabId); firefoxFrameRouting.forget(tabId);
            commandHealth.recovered(tabId);
        }
        return {};
    })();
    commandHealth.track(tabId, task);
    return beforeDeadline(() => task, Date.now() + 2500, { tabId, phase: "detach", method: "detach" });
}
const { executeCdp, executeInputGesture } = createCdpRuntime({ DEFAULT_CDP_TIMEOUT_MS, IS_FIREFOX, rpc, errorMessage, attachedTabs, chrome, record, beforeDeadline, commandHealth, queryTabs, tabIdFromParams, ensureControlledTab, assertSessionUrl, getTab, firefoxFrameRouting, frameRouting, withTabLock, guardedCdp, uploadConsent, uploadTargetUrl, sendCdpCommand, cursorIdFromParams, finiteNumber, gestureAction, moveMouse, publishCursorState, partialDispatchError, attachTab, cursorStateByTabId, framePoint, cursorStatesForTab });
function sendCdpCommand<K extends CdpMethod>(tabId: number, method: K, commandParams: CdpParams<K>, timeoutMs?: number, sessionId?: string): Promise<CdpResult<K>>;
function sendCdpCommand(tabId: number, method: string, commandParams: object, timeoutMs?: number, sessionId?: string): Promise<unknown>;
async function sendCdpCommand(tabId: number, method: string, commandParams: object, timeoutMs = DEFAULT_CDP_TIMEOUT_MS, sessionId?: string): Promise<unknown> {
    if (IS_FIREFOX)
        return rpc.request("firefox.command", { tabId, method, commandParams, timeoutMs }, { timeoutMs: timeoutMs + 5000 }).catch(error => {
            if (/bridge required|connection closed|remote connection/i.test(errorMessage(error)))
                attachedTabs.delete(tabId);
            throw error;
        });
    const task = new Promise<unknown>((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, record(commandParams), (result) => {
            const error = chrome.runtime.lastError;
            if (error)
                reject(Object.assign(new Error(error.message), /could not find (object|node)|no node with given id|cannot find context|no frame for given id|cannot find frame/i.test(error.message ?? "") ? { code: "STALE_TARGET", uncertain: false, executionState: "not_started" } : {}));
            else
                resolve(result ?? {});
        });
    });
    return beforeDeadline(() => task, Date.now() + timeoutMs, { tabId, phase: "command", method, dialogType: commandHealth.dialog(tabId)?.type }).catch(error => {
        if (record(error).code === "TIMEOUT") commandHealth.track(tabId, task);
        throw error;
    });
}
const recordInlineBrowserResponse = createInlineResponseRecorder({ downloadEvents, inlineResponseEventKeys, maxInlineResponseKeys: MAX_INLINE_RESPONSE_KEYS });
registerRuntimeMethods({ rpc, profileMetadata, setProfileLabel, attachTab, detachTab, executeCdp, executeInputGesture, resolveTabActivation, moveMouse, framePoint, tabIdFromParams, cursorIdFromParams, cursorArrivalWaiters, cursorWaiterKey, cdpEventsByTabId, traceBuffers, MAX_TRACE_CHUNKS, requiredSessionId, sessionState, updateTurn, focusedNormalWindowId, creationRequestIds, trackTab, getTab, assertClaimableTab, normalizeTab, queryTabs, isClaimableTab, findTabOwner, assertSessionUrl, untrackTab, ensureControlledTab, hideCursor, ungroupTab, persistSessions, normalizeKeepItem, commandHealth, sessions, SESSION_GROUP_COLOR, downloadEvents, IS_FIREFOX, attachedTabs, recordCdpEvent, sendCdpCommand, HOST_NAME, focusTab, nowIso, uploadConsent, reconciliationToken: () => reconciliationToken });
if (!IS_FIREFOX) chrome.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) { commandHealth.invalidate(source.tabId); frameRouting.forget(source.tabId); } });
if (!IS_FIREFOX) chrome.debugger.onEvent.addListener((source, method, params) => { if (source.tabId !== undefined && attachedTabs.has(source.tabId)) frameRouting.event(source, method, params); });
if (!IS_FIREFOX)
    installChromiumEvents({ chrome, cdpEventTabId, traceBuffers, MAX_TRACE_CHUNKS, recordCdpEvent, attachedTabs });
installNavigationPolicy({ chrome, findOwner: findTabOwner, trackTab, getTab, stopLoading: tabId => sendCdpCommand(tabId, "Page.stopLoading", {}, 2000) });
chrome.tabs.onRemoved.addListener((tabId) => {
    creationRequestIds.delete(tabId);
    attachedTabs.delete(tabId);
    commandHealth.removed(tabId);
    frameRouting.forget(tabId);
    cdpEventsByTabId.delete(tabId);
    traceBuffers.delete(tabId);
    cursorStateByTabId.delete(tabId);
    cursorInjectedTabs.delete(tabId);
    const owner = findTabOwner(tabId);
    if (owner)
        void untrackTab(owner.sessionId, tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || typeof changeInfo.url === "string")
        cursorInjectedTabs.delete(tabId);
});
popupRuntime = createPopupRuntime({ rpc, hostStatus, updateVersionBadge, connectionIdle, errorMessage, storageSet, VERSION_REMINDER_KEY, profileMetadata, publicProfile, setProfileLabel, sanitizeSemanticForPopup, uploadConsent, cursorArrivalWaiters, cursorWaiterKey, currentCursorStates });
function createAlarms() {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(details => {
    createAlarms();
    rpc.connect();
    void openInstallGuide(chrome, details).catch(() => { });
});
chrome.runtime.onStartup.addListener(() => {
    createAlarms();
    void restoreSessions().catch(() => { });
    rpc.connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM)
        rpc.connect();
    if (alarm.name === HEARTBEAT_ALARM) {
        void updateVersionBadge();
        rpc.heartbeat();
    }
});
createAlarms();
void restoreSessions().catch(() => { });
rpc.connect();
