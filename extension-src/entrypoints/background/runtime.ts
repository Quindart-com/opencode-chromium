import type { Browser } from "wxt/browser";
import { browser as chrome } from "wxt/browser";
import { z } from "zod/mini";
import type { CdpMethod,CdpParams,CdpResult } from "../../../src/shared/cdp.ts";
import { record } from "../../../src/shared/values.ts";
import type { VersionStatus } from "../../version-status.ts";
import { validVersion,versionNotice } from "../../version-status.ts";
import type { CommandParams,KeepItem } from "./command-schema.ts";
import type { CursorState } from "./cursor-state.ts";
import { CURSOR_SCRIPTS,cursorIdFromParams,cursorState,gestureAction } from "./cursor-state.ts";
import { createDebuggerAttacher,installChromiumEvents } from "./debugger-attach.ts";
import { createDownloadEvents,registerDownloadHandlers } from "./download-events.ts";
import { createFirefoxAttacher,registerDecisionImageCapture } from "./firefox-bridge.ts";
import { resolveTabActivation } from "./focus-policy.ts";
import { NativeRpc } from "./native-rpc.ts";
import { assertSessionUrl,installNavigationPolicy,updateSessionPolicy } from "./navigation-policy.ts";
import { openInstallGuide } from "./onboarding.ts";
import { popupMessageSchema,uploadMessageSchema } from "./popup-schema.ts";
import { assertTabAccess } from "./tab-ownership.ts";
import type { ExtensionSession,TabOwner,TraceBuffer } from "./types.ts";
import { createUploadConsent } from "./upload-consent.ts";
import { guardedCdp,uploadTargetUrl } from "./upload-gate.ts";
type CdpEvent = {
    time: string;
    tabId: number;
    method: string;
    params: Record<string, unknown>;
};
type ProfileState = {
    profileId: string;
    profileLabel: string | null;
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
const DELIVERABLE_GROUP_TITLE = "OpenCode Deliverables";
const DELIVERABLE_GROUP_COLOR = "blue";
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
let versionCheckGeneration = 0;
let restoringSessions = 0;
const sessions = new Map<string, ExtensionSession>();
const attachedTabs = new Map<number, string>();
const tabLocks = new Map<number, Promise<void>>();
const cdpEventsByTabId = new Map<number, CdpEvent[]>();
const traceBuffers = new Map<number, TraceBuffer>();
const cursorStateByTabId = new Map<number, Map<string, CursorState>>();
const cursorArrivalWaiters = new Map<string, () => void>();
const cursorInjectedTabs = new Set<number>();
const downloadEvents = createDownloadEvents({ ownerForTab: tabId => findTabOwner(tabId)?.sessionId ?? null, maxEvents: MAX_DOWNLOAD_EVENTS });
const inlineResponseEventKeys = new Set<string>();
let deliverableGroupId: number | null = null;
let profileStatePromise: Promise<ProfileState> | null = null;
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
    connected() { ++versionCheckGeneration; void announceProfile().catch(() => { }); },
    disconnected() { ++versionCheckGeneration; },
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
function randomProfileId() {
    if (globalThis.crypto?.randomUUID)
        return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function normalizeProfileLabel(label: unknown): string | null {
    if (label === null || label === undefined)
        return null;
    const normalized = String(label).replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
    return normalized.length > 0 ? normalized : null;
}
function browserNameFromUserAgent() {
    if (IS_FIREFOX)
        return "Firefox";
    const userAgent = navigator.userAgent ?? "";
    if (/Edg\//.test(userAgent))
        return "Microsoft Edge";
    if (/OPR\//.test(userAgent))
        return "Opera";
    if (/Chrome\//.test(userAgent))
        return "Chromium";
    return "Chromium-based browser";
}
async function getProfileState(): Promise<ProfileState> {
    if (profileStatePromise)
        return profileStatePromise;
    profileStatePromise = (async () => {
        const stored = (await storageGet(PROFILE_STORAGE_KEY).catch((): Record<string, unknown> => ({})))?.[PROFILE_STORAGE_KEY];
        const profile = record(stored);
        const state = {
            profileId: typeof profile.profileId === "string" && profile.profileId.length > 0 ? profile.profileId : randomProfileId(),
            profileLabel: normalizeProfileLabel(profile.profileLabel),
        };
        await storageSet({ [PROFILE_STORAGE_KEY]: state }).catch(() => { });
        return state;
    })();
    return profileStatePromise;
}
async function setProfileLabel(label: unknown) {
    const current = await getProfileState();
    const next = { ...current, profileLabel: normalizeProfileLabel(label) };
    profileStatePromise = Promise.resolve(next);
    await storageSet({ [PROFILE_STORAGE_KEY]: next });
    await announceProfile().catch(() => { });
    return profileMetadata();
}
async function profileMetadata() {
    const profile = await getProfileState();
    const manifest = chrome.runtime.getManifest();
    return {
        profileId: profile.profileId,
        profileIdMasked: maskIdentifier(profile.profileId),
        profileLabel: profile.profileLabel,
        browserName: browserNameFromUserAgent(),
        extensionId: chrome.runtime.id,
        extensionVersion: manifest.version,
    };
}
function maskIdentifier(value: unknown): string {
    if (typeof value !== "string" || value.length === 0)
        return "";
    if (value.length <= 8)
        return `${value[0]}…`;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
function publicProfile(profile: Awaited<ReturnType<typeof profileMetadata>>) {
    if (!profile || typeof profile !== "object")
        return profile;
    const { profileId, profileIdMasked, ...rest } = profile;
    const masked = profileId ? maskIdentifier(profileId) : (typeof profileIdMasked === "string" ? profileIdMasked : "");
    return { ...rest, profileIdMasked: masked };
}
function sanitizeSemanticForPopup(semantic: unknown) {
    if (!semantic || typeof semantic !== "object")
        return semantic;
    const { cacheDir: _cacheDir, ...rest } = record(semantic);
    return rest;
}
async function announceProfile() {
    const generation = ++versionCheckGeneration;
    const result = await rpc.request("profile.hello", { ...await profileMetadata(), uploadConsentVersion: 1 }).catch(() => null);
    const reminder = (await storageGet(VERSION_REMINDER_KEY).catch((): Record<string, unknown> => ({})))[VERSION_REMINDER_KEY] ?? null;
    if (generation !== versionCheckGeneration || hostStatus.state !== "connected")
        return;
    hostStatus.versionReminder = z.object({ key: z.string(), until: z.number() }).safeParse(reminder).data ?? null;
    applyHostVersions(result);
}
function applyHostVersions(value: unknown) {
    const result = record(value);
    hostStatus.versionChecked = true;
    hostStatus.unknownClientVersion = result?.unknownClientVersion === true;
    hostStatus.nativeHostVersion = validVersion(result?.nativeHostVersion);
    hostStatus.clientVersions = Array.isArray(result?.clientVersions) ? result.clientVersions.map(validVersion).filter((version): version is string => version !== null) : [];
    broadcastNativeStatus();
}
rpc.register("host.versions", async (params) => { applyHostVersions(params); return {}; });
rpc.register("runtime.canReconnect", async () => ({ idle: restoringSessions === 0 && rpc.idle() && sessions.size === 0 && attachedTabs.size === 0 && tabLocks.size === 0 && traceBuffers.size === 0 }));
async function updateVersionBadge() {
    const notice = versionNotice(chrome.runtime.getManifest().version, hostStatus);
    if (!chrome.action?.setBadgeText)
        return;
    await chrome.action.setBadgeText({ text: notice && !notice.snoozed ? (notice.kind === "unknown" ? "?" : "!") : "" }).catch(() => { });
    await chrome.action.setBadgeBackgroundColor({ color: "#a86b00" }).catch(() => { });
}
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
    const status = typeof item === "number" ? "handoff" : item.status ?? "handoff";
    if (typeof tabId !== "number" || !Number.isInteger(tabId))
        throw new Error("Expected keep item tabId");
    if (status !== "handoff" && status !== "deliverable")
        throw new Error(`Unsupported keep status: ${status}`);
    return { tabId, status };
}
function isBrowserInternalUrl(url: string | undefined): boolean {
    return /^(chrome|edge|brave|vivaldi|opera|chrome-extension|moz-extension):/i.test(url ?? "") || (/^about:/i.test(url ?? "") && url !== "about:blank");
}
function normalizeTab<T extends object>(tab: Browser.tabs.Tab, extra: T = {} as T) {
    const owner = tab.id !== undefined && Number.isInteger(tab.id) ? findTabOwner(tab.id) : null;
    return {
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
        const parsed = z.object({ name: z.optional(z.nullable(z.string())), urlPolicy: z.optional(z.nullable(z.object({ allowedOrigins: z.optional(z.array(z.string())), blockedOrigins: z.optional(z.array(z.string())) }))), groupId: z.optional(z.nullable(z.int())), activeTabId: z.optional(z.nullable(z.int())), currentTurnId: z.optional(z.nullable(z.string())), tabOrigins: z.optional(z.record(z.string(), z.string())), tabIds: z.optional(z.array(z.int())) }).safeParse(value);
        if (!parsed.success)
            continue;
        const serialized = parsed.data;
        const session = sessionState(id);
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
async function groupTitle(groupId: number) {
    if (groupId === null || !Number.isInteger(groupId) || groupId < 0 || !chrome.tabGroups)
        return null;
    const group = await chrome.tabGroups.get(groupId).catch(() => null);
    return group?.title ?? null;
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
async function ensureDeliverableGroup(tabId: number) {
    if (!chrome.tabs.group || !chrome.tabGroups)
        return null;
    const tab = await getTab(tabId);
    const windowId = tab.windowId;
    let groupId = null;
    if (deliverableGroupId !== null && Number.isInteger(deliverableGroupId)) {
        const cachedGroup = await chrome.tabGroups.get(deliverableGroupId).catch(() => null);
        if (cachedGroup?.title === DELIVERABLE_GROUP_TITLE && cachedGroup.windowId === windowId) {
            groupId = cachedGroup.id;
        }
    }
    if (!Number.isInteger(groupId) && typeof chrome.tabGroups.query === "function") {
        const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
        groupId = groups.find((group) => group.title === DELIVERABLE_GROUP_TITLE && group.windowId === windowId)?.id ?? null;
    }
    if (groupId === null || !Number.isInteger(groupId)) {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(groupId, { title: DELIVERABLE_GROUP_TITLE, color: DELIVERABLE_GROUP_COLOR }).catch(() => { });
    }
    else {
        await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
    deliverableGroupId = groupId;
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
async function injectCursor(tabId: number, options: {
    force?: boolean;
} = {}) {
    if (!chrome.scripting?.executeScript)
        return false;
    if (!options.force && cursorInjectedTabs.has(tabId))
        return true;
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: CURSOR_SCRIPTS, injectImmediately: true });
        cursorInjectedTabs.add(tabId);
        return true;
    }
    catch {
        cursorInjectedTabs.delete(tabId);
        return false;
    }
}
function cursorWaiterKey(tabId: number, cursorId: string, moveSequence: number) {
    return `${tabId}:${cursorId}:${moveSequence}`;
}
async function waitForCursorArrival(tabId: number, cursorId: string, moveSequence: number, timeoutMs: number) {
    const key = cursorWaiterKey(tabId, cursorId, moveSequence);
    return new Promise<{
        arrived: boolean;
        timedOut: boolean;
    }>((resolve) => {
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
async function publishCursorState(tabId: number, state: CursorState) {
    const cursorId = state.cursorId ?? "default";
    cursorStatesForTab(tabId).set(cursorId, { ...state, cursorId });
    if (!(await injectCursor(tabId)))
        throw new Error(`Could not inject cursor overlay into tab ${tabId}`);
    try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "OPENCODE_CURSOR_STATE", ...state, cursorId });
        return { delivered: true, retried: false, response };
    }
    catch {
        cursorInjectedTabs.delete(tabId);
    }
    if (await injectCursor(tabId, { force: true })) {
        const response = await chrome.tabs.sendMessage(tabId, { type: "OPENCODE_CURSOR_STATE", ...state, cursorId });
        return { delivered: true, retried: true, response };
    }
    throw new Error(`Could not deliver cursor state to tab ${tabId}`);
}
async function moveMouse(params: CommandParams) {
    const tabId = tabIdFromParams(params);
    const { session } = ensureControlledTab(params, tabId);
    const cursorId = cursorIdFromParams(params);
    const previous = cursorStateByTabId.get(tabId)?.get(cursorId);
    const moveSequence = params.moveSequence !== undefined && Number.isInteger(params.moveSequence)
        ? params.moveSequence
        : (previous?.moveSequence ?? 0) + 1;
    const state = cursorState({
        cursorId,
        session,
        x: finiteNumber(params.x, "x"),
        y: finiteNumber(params.y, "y"),
        visible: params.visible !== false,
        moveSequence,
        action: typeof params.action === "string" ? params.action : null,
    });
    const arrival = params.waitForArrival
        ? waitForCursorArrival(tabId, cursorId, moveSequence, params.timeoutMs ?? 2000)
        : null;
    const delivery = await publishCursorState(tabId, state);
    if (arrival) {
        const result = await arrival;
        if (result.timedOut)
            throw new Error(`Cursor did not report arrival within ${params.timeoutMs ?? 2000}ms`);
        return { ...result, ...delivery };
    }
    return { moveSequence, cursorId, ...delivery };
}
async function hideCursor(tabId: number, cursorId?: string) {
    const states = cursorStateByTabId.get(tabId);
    const ids = cursorId ? [cursorId] : [...(states?.keys() ?? ["default"])];
    for (const id of ids) {
        const previous = states?.get(id) ?? { x: -100, y: -100, moveSequence: 0, cursorId: id, label: id, visible: false };
        await publishCursorState(tabId, { ...previous, cursorId: id, visible: false, moveSequence: previous.moveSequence + 1 });
    }
}
async function withTabLock<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = tabLocks.get(tabId) ?? Promise.resolve();
    let release: () => void = () => { };
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const stored = previous.catch(() => { }).then(() => gate);
    tabLocks.set(tabId, stored);
    await previous.catch(() => { });
    try {
        return await operation();
    }
    finally {
        release();
        if (tabLocks.get(tabId) === stored)
            tabLocks.delete(tabId);
    }
}
const attachChromiumTab = createDebuggerAttacher({ withTabLock, attachedTabs, isBrowserInternalUrl, getTab, chromeCall, chrome, DEBUGGER_VERSION, errorMessage, sendCdpCommand, DEFAULT_CDP_TIMEOUT_MS });
const attachTab = IS_FIREFOX ? createFirefoxAttacher({ withTabLock, getTab, isBrowserInternalUrl, attachedTabs, chromeCall, chrome, rpc }) : attachChromiumTab;
async function detachTab(tabId: number) {
    return withTabLock(tabId, async () => {
        if (!attachedTabs.has(tabId))
            return {};
        if (IS_FIREFOX)
            await rpc.request("firefox.detach", { tabId }).catch(() => { });
        else
            await chrome.debugger.detach({ tabId }).catch(() => { });
        if (IS_FIREFOX)
            await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (globalThis.__opencodeFileGuard)
                    document.removeEventListener("click", globalThis.__opencodeFileGuard, true); delete globalThis.__opencodeFileGuard; } }).catch(() => { });
        attachedTabs.delete(tabId);
        return {};
    });
}
function commandTimeoutMs(params: CommandParams): number {
    const timeoutMs = params.timeoutMs ?? params.timeout_ms ?? DEFAULT_CDP_TIMEOUT_MS;
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CDP_TIMEOUT_MS;
}
function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function sendCdpCommand<K extends CdpMethod>(tabId: number, method: K, commandParams: CdpParams<K>, timeoutMs?: number): Promise<CdpResult<K>>;
function sendCdpCommand(tabId: number, method: string, commandParams: object, timeoutMs?: number): Promise<unknown>;
async function sendCdpCommand(tabId: number, method: string, commandParams: object, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<unknown> {
    if (IS_FIREFOX)
        return rpc.request("firefox.command", { tabId, method, commandParams, timeoutMs }).catch(error => {
            if (/bridge required|connection closed|remote connection/i.test(errorMessage(error)))
                attachedTabs.delete(tabId);
            throw error;
        });
    let timeoutId: ReturnType<typeof setTimeout>;
    let settled = false;
    return new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            void detachTab(tabId);
            reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        chrome.debugger.sendCommand({ tabId }, method, record(commandParams), (result) => {
            const error = chrome.runtime.lastError;
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutId);
            if (error)
                reject(new Error(error.message));
            else
                resolve(result ?? {});
        });
    });
}
async function executeCdp(params: CommandParams) {
    const method = params.method;
    if (typeof method !== "string" || method.length === 0)
        throw new Error("Expected CDP method");
    if (method === "Target.getTargets") {
        if (IS_FIREFOX)
            return { targetInfos: (await queryTabs({})).map(tab => ({ targetId: String(tab.id), type: "page", url: tab.url, title: tab.title })) };
        const targets = await chrome.debugger.getTargets();
        return { targetInfos: targets };
    }
    const tabId = tabIdFromParams(params);
    const { session } = ensureControlledTab(params, tabId);
    if (method === "Page.navigate")
        assertSessionUrl(session, params.commandParams?.url ?? params.command_params?.url ?? "");
    else if ((session.urlPolicy?.allowedOrigins?.length || session.urlPolicy?.blockedOrigins?.length) && !/^(Page.stopLoading|Emulation.clear|Network.setExtraHTTPHeaders|Page.removeScriptToEvaluateOnNewDocument)/.test(method))
        assertSessionUrl(session, (await getTab(tabId)).url ?? "about:blank");
    if (!attachedTabs.has(tabId))
        throw new Error("Debugger unattached");
    return withTabLock(tabId, () => guardedCdp({ method, tabId, consent: uploadConsent, getTab,
        inspectTarget: (method, command) => uploadTargetUrl(method, command, (method, command) => sendCdpCommand(tabId, method, command, DEFAULT_CDP_TIMEOUT_MS)),
        commandParams: params.commandParams ?? params.command_params ?? {},
        send: command => sendCdpCommand(tabId, method, command, commandTimeoutMs(params)),
    }));
}
async function executeInputGesture(params: CommandParams) {
    const tabId = tabIdFromParams(params);
    const methodTimeoutMs = commandTimeoutMs(params);
    const { sessionId, session } = ensureControlledTab(params, tabId);
    const cursorId = cursorIdFromParams(params);
    const steps = Array.isArray(params.steps) ? params.steps : [];
    if (!steps.length)
        throw new Error("inputGesture requires at least one step");
    if (steps.length > 5000)
        throw new Error(`inputGesture step limit exceeded: ${steps.length}`);
    for (const [index, step] of steps.entries()) {
        if (step.cursor) {
            finiteNumber(step.cursor.x, `steps[${index}].cursor.x`);
            finiteNumber(step.cursor.y, `steps[${index}].cursor.y`);
        }
        const params = step.commandParams ?? step.command_params;
        if (params && (step.method === "Input.dispatchMouseEvent" || step.method === "Input.dispatchTouchEvent")) {
            if (params.x !== undefined)
                finiteNumber(params.x, `steps[${index}].commandParams.x`);
            if (params.y !== undefined)
                finiteNumber(params.y, `steps[${index}].commandParams.y`);
        }
    }
    await attachTab(tabId, sessionId);
    let moveSequence = cursorStateByTabId.get(tabId)?.get(cursorId)?.moveSequence ?? 0;
    return withTabLock(tabId, async () => {
        const results = [];
        const hasCursorSteps = steps.some((s) => s.cursor && Number.isFinite(s.cursor.x) && Number.isFinite(s.cursor.y));
        const cursorPublishInterval = hasCursorSteps && steps.length > 20 ? Math.max(1, Math.floor(steps.length / 20)) : 1;
        let stepIndex = 0;
        let pointerDown = false;
        for (const step of steps) {
            stepIndex += 1;
            const isLast = stepIndex === steps.length;
            const commandParams = step.commandParams ?? step.command_params ?? {};
            const action = gestureAction(step, pointerDown);
            if (step.cursor && Number.isFinite(step.cursor.x) && Number.isFinite(step.cursor.y)) {
                moveSequence += 1;
                const patch = cursorState({
                    cursorId,
                    session,
                    x: step.cursor.x,
                    y: step.cursor.y,
                    visible: step.cursor.visible !== false,
                    moveSequence,
                    action,
                });
                if (isLast || stepIndex % cursorPublishInterval === 1)
                    await publishCursorState(tabId, patch);
                else
                    cursorStatesForTab(tabId).set(cursorId, patch);
            }
            if (step.method === "Input.dispatchMouseEvent")
                pointerDown = commandParams.type !== "mouseReleased" && Number(commandParams.buttons) > 0;
            if (typeof step.method === "string" && step.method.length > 0) {
                results.push(await guardedCdp({ method: step.method, tabId, consent: uploadConsent, getTab,
                    inspectTarget: (method, command) => uploadTargetUrl(method, command, (method, command) => sendCdpCommand(tabId, method, command, DEFAULT_CDP_TIMEOUT_MS)),
                    commandParams,
                    send: command => sendCdpCommand(tabId, step.method, command, step.timeoutMs !== undefined && Number.isFinite(step.timeoutMs) && step.timeoutMs > 0 ? step.timeoutMs : methodTimeoutMs),
                }));
            }
            const delayMs = Number(step.delayMs ?? step.delay_ms ?? 0);
            if (delayMs > 0)
                await sleep(Math.min(delayMs, 1000));
        }
        return { results, cursorId, moveSequence };
    });
}
function headerValue(headers: unknown, name: string): unknown {
    if (!headers || typeof headers !== "object")
        return null;
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(record(headers))) {
        if (key.toLowerCase() === expected)
            return Array.isArray(value) ? value[0] : value;
    }
    return null;
}
function filenameFromDisposition(disposition: unknown): string | null {
    if (typeof disposition !== "string")
        return null;
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded);
        }
        catch {
            return encoded;
        }
    }
    return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}
function recordInlineBrowserResponse(tabId: number, method: string, params: unknown) {
    if (method !== "Network.responseReceived")
        return;
    const event = record(params);
    const response = record(event.response);
    const mime = String(response?.mimeType ?? headerValue(response?.headers, "content-type") ?? "").toLowerCase();
    if (!mime.includes("application/pdf"))
        return;
    const url = response?.url ?? event.documentURL ?? null;
    const key = `${tabId}:${event.requestId ?? inlineResponseEventKeys.size}`;
    if (inlineResponseEventKeys.has(key))
        return;
    inlineResponseEventKeys.add(key);
    if (inlineResponseEventKeys.size > MAX_INLINE_RESPONSE_KEYS)
        inlineResponseEventKeys.delete(inlineResponseEventKeys.values().next().value ?? "");
    const totalBytes = Number(headerValue(response?.headers, "content-length"));
    downloadEvents.recordInline(tabId, `inline:${key}`, {
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
rpc.register("ping", async () => "pong");
rpc.register("getInfo", async () => {
    const profile = await profileMetadata();
    return {
        id: chrome.runtime.id,
        name: "opencode-browser-plugin",
        version: chrome.runtime.getManifest().version,
        type: "extension",
        engine: IS_FIREFOX ? "gecko" : "chromium",
        profile,
        capabilities: {
            browser: [
                { id: "profiles", description: "Select among currently open browser profiles without launching closed profiles." },
                { id: "tabs", description: "Create, claim, list, finalize, and navigate Chromium tabs." },
                { id: "history", description: "Read browser history through the extension history permission." },
                { id: "downloads", description: "Observe attributed download events from this session's controlled tabs." },
                { id: "semantic", description: "Configure local semantic page retrieval models in the native host." },
                { id: "visual-map", description: "Return lean visible UI boxes and optionally use local screenshot detection in the native host." },
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
            profileId: profile.profileId,
            profileLabel: profile.profileLabel,
        },
    };
});
rpc.register("getProfile", async () => profileMetadata());
rpc.register("setProfileLabel", async (params) => setProfileLabel(params.label));
rpc.register("attach", async (params) => {
    const tabId = tabIdFromParams(params);
    const { sessionId } = ensureControlledTab(params, tabId);
    return attachTab(tabId, sessionId);
});
rpc.register("detach", async (params) => detachTab(tabIdFromParams(params)));
rpc.register("executeCdp", executeCdp);
rpc.register("uploadPolicy", async () => ({ version: 1 }));
rpc.register("inputGesture", executeInputGesture);
rpc.register("activateTab", async (params) => {
    const tabId = tabIdFromParams(params);
    const { session } = ensureControlledTab(params, tabId);
    session.activeTabId = tabId;
    await persistSessions().catch(() => { });
    const activation = resolveTabActivation(params);
    return normalizeTab(await focusTab(tabId, activation));
});
rpc.register("moveMouse", moveMouse);
rpc.register("notifyCursorArrived", async (params) => {
    const tabId = tabIdFromParams(params);
    const cursorId = cursorIdFromParams(params);
    const moveSequence = params.moveSequence ?? params.move_sequence;
    if (moveSequence === undefined)
        throw new Error("Expected move sequence");
    const waiter = cursorArrivalWaiters.get(cursorWaiterKey(tabId, cursorId, moveSequence));
    if (waiter)
        waiter();
    return {};
});
rpc.register("getCdpEvents", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    const methods = Array.isArray(params.methods) ? new Set(params.methods) : null;
    const prefix = typeof params.methodPrefix === "string" ? params.methodPrefix : null;
    const limit = params.limit !== undefined && Number.isInteger(params.limit) ? params.limit : 100;
    let events = cdpEventsByTabId.get(tabId) ?? [];
    if (methods)
        events = events.filter((event) => methods.has(event.method));
    if (prefix)
        events = events.filter((event) => event.method.startsWith(prefix));
    return { events: events.slice(-limit) };
});
rpc.register("clearCdpEvents", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    cdpEventsByTabId.delete(tabId);
    return {};
});
rpc.register("trace.begin", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    traceBuffers.set(tabId, { chunks: [], complete: false, overflowed: false, eventCount: 0, startedAt: nowIso(), endTime: null });
    return { started: true, tabId };
});
rpc.register("trace.collect", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    const buffer = traceBuffers.get(tabId);
    if (!buffer)
        return { collecting: false, chunkCount: 0, eventCount: 0, chunks: [] };
    const clear = params.clear === true;
    const result = {
        collecting: true,
        complete: buffer.complete === true,
        overflowed: buffer.overflowed === true,
        chunkCount: buffer.chunks.length,
        eventCount: buffer.eventCount,
        startedAt: buffer.startedAt,
        ...(buffer.complete ? { endTime: buffer.endTime } : {}),
        chunks: clear ? buffer.chunks.splice(0, buffer.chunks.length) : buffer.chunks,
    };
    if (clear)
        traceBuffers.delete(tabId);
    return result;
});
rpc.register("trace.clear", async (params) => {
    const tabId = tabIdFromParams(params);
    traceBuffers.delete(tabId);
    return {};
});
rpc.register("createTab", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    updateTurn(session, params);
    const windowId = await focusedNormalWindowId();
    let tab;
    if (windowId !== null && Number.isInteger(windowId)) {
        tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    }
    else {
        const window = await chrome.windows.create({ focused: false, type: "normal", url: "about:blank" });
        tab = window?.tabs?.[0];
        if (!tab?.id)
            throw new Error("Could not create browser tab");
    }
    if (tab.id === undefined)
        throw new Error("Could not identify browser tab");
    await trackTab(id, tab.id, "agent");
    return normalizeTab(tab);
});
rpc.register("claimUserTab", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    updateTurn(session, params);
    const tabId = tabIdFromParams(params);
    assertTabAccess({ owner: findTabOwner(tabId), sessionId: id, tabId, allowUnowned: true });
    const tab = await getTab(tabId);
    if (isBrowserInternalUrl(tab.url))
        throw new Error(`Cannot claim internal browser tab: ${tab.url}`);
    assertSessionUrl(session, tab.url ?? "about:blank");
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
            if (isBrowserInternalUrl(tab.url))
                continue;
            try {
                assertSessionUrl(session, tab.url ?? "about:blank");
            }
            catch {
                continue;
            }
            tabs.push(normalizeTab(tab, {
                selected: session.activeTabId === tabId,
                origin: session.tabOrigins.get(tabId) ?? "agent",
            }));
        }
        catch {
            await untrackTab(id, tabId);
        }
    }
    return { tabs };
});
rpc.register("getSelectedTab", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    updateTurn(session, params);
    if (session.activeTabId === null || !Number.isInteger(session.activeTabId) || !session.tabIds.has(session.activeTabId))
        return null;
    try {
        return normalizeTab(await getTab(session.activeTabId), { selected: true });
    }
    catch {
        await untrackTab(id, session.activeTabId);
        return null;
    }
});
rpc.register("getTab", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    const tab = await getTab(tabId);
    assertSessionUrl(sessionState(requiredSessionId(params)), tab.url ?? "about:blank");
    return normalizeTab(tab);
});
rpc.register("getUserTabs", async () => {
    const tabs = await queryTabs({});
    const groupTitles = new Map();
    const normalized = [];
    for (const tab of tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 1000)) {
        let tabGroup = null;
        if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
            if (!groupTitles.has(tab.groupId))
                groupTitles.set(tab.groupId, await groupTitle(tab.groupId));
            tabGroup = groupTitles.get(tab.groupId);
        }
        normalized.push(normalizeTab(tab, { tabGroup, claimable: tab.id !== undefined && !findTabOwner(tab.id) && !isBrowserInternalUrl(tab.url) }));
    }
    return { tabs: normalized };
});
rpc.register("getUserHistory", async (params) => {
    const items = await chrome.history.search({
        text: params.query ?? "",
        maxResults: params.limit ?? 25,
        startTime: params.from ? Date.parse(params.from) : 0,
        endTime: params.to ? Date.parse(params.to) : Date.now(),
    });
    return {
        items: items.map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title ?? null,
            dateVisited: typeof item.lastVisitTime === "number" && Number.isFinite(item.lastVisitTime) ? new Date(item.lastVisitTime).toISOString() : null,
            visitCount: item.visitCount ?? null,
            typedCount: item.typedCount ?? null,
        })),
    };
});
rpc.register("closeTab", async (params) => {
    const tabId = tabIdFromParams(params);
    const { sessionId } = ensureControlledTab(params, tabId);
    await detachTab(tabId);
    await chrome.tabs.remove(tabId);
    await untrackTab(sessionId, tabId);
    return {};
});
rpc.register("releaseTab", async (params) => {
    const tabId = tabIdFromParams(params);
    const { sessionId, session } = ensureControlledTab(params, tabId);
    const origin = session.tabOrigins.get(tabId) ?? "agent";
    await detachTab(tabId);
    await hideCursor(tabId).catch(() => { });
    await ungroupTab(tabId).catch(() => { });
    await untrackTab(sessionId, tabId);
    await persistSessions().catch(() => { });
    return { released: true, tabId, origin };
});
rpc.register("reloadTab", async (params) => {
    const tabId = tabIdFromParams(params);
    ensureControlledTab(params, tabId);
    await chrome.tabs.reload(tabId, { bypassCache: Boolean(params.bypassCache) });
    return {};
});
rpc.register("finalizeTabs", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    updateTurn(session, params);
    const keep = new Map((params.keep ?? []).map((item) => {
        const normalized = normalizeKeepItem(item);
        if (!session.tabIds.has(normalized.tabId))
            throw new Error(`Cannot keep unmanaged tab ${normalized.tabId}`);
        return [normalized.tabId, normalized.status];
    }));
    for (const tabId of [...session.tabIds]) {
        const status = keep.get(tabId);
        const origin = session.tabOrigins.get(tabId) ?? "agent";
        await detachTab(tabId);
        await hideCursor(tabId).catch(() => { });
        if (status) {
            if (status === "deliverable") {
                await ensureDeliverableGroup(tabId).catch(() => { });
                await untrackTab(id, tabId);
            }
            continue;
        }
        if (origin === "user") {
            await ungroupTab(tabId);
            await untrackTab(id, tabId);
            continue;
        }
        await chrome.tabs.remove(tabId).catch(() => { });
        await untrackTab(id, tabId);
    }
    await persistSessions().catch(() => { });
    return {};
});
rpc.register("turnEnded", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    for (const tabId of [...session.tabIds]) {
        await detachTab(tabId);
        await hideCursor(tabId).catch(() => { });
    }
    session.currentTurnId = null;
    await persistSessions().catch(() => { });
    return {};
});
rpc.register("nameSession", async (params) => {
    const session = sessionState(requiredSessionId(params));
    updateTurn(session, params);
    if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 120)
        throw new Error("Session name must contain 1 to 120 characters.");
    session.name = params.name.trim();
    if (session.groupId !== null && Number.isInteger(session.groupId) && chrome.tabGroups) {
        await chrome.tabGroups.update(session.groupId, { title: session.name ?? "OpenCode", color: SESSION_GROUP_COLOR });
    }
    await persistSessions().catch(() => { });
    return {};
});
registerDownloadHandlers({ rpc, downloads: downloadEvents, requiredSessionId, capabilities: IS_FIREFOX ? async () => z.object({ started: z.boolean(), completed: z.boolean() }).parse(await rpc.request("firefox.downloadCapabilities", {})) : null });
rpc.register("executeUnhandledCommand", async (params) => ({ handled: false, command: params.command ?? null }));
rpc.register("firefox.event", async ({ tabId, method, params }) => {
    if (IS_FIREFOX && tabId !== undefined && typeof method === "string" && attachedTabs.has(tabId))
        recordCdpEvent({ tabId }, method, record(params));
    return {};
});
registerDecisionImageCapture({ rpc, tabIdFromParams, ensureControlledTab, getTab, isBrowserInternalUrl, attachTab, requiredSessionId, sendCdpCommand });
if (!IS_FIREFOX)
    installChromiumEvents({ chrome, cdpEventTabId, traceBuffers, MAX_TRACE_CHUNKS, recordCdpEvent, attachedTabs });
installNavigationPolicy({ chrome, findOwner: findTabOwner, trackTab, getTab, stopLoading: tabId => sendCdpCommand(tabId, "Page.stopLoading", {}, 2000) });
chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
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
const statusPorts = new Set<Browser.runtime.Port>();
const POPUP_MEMORY_METHODS = new Set([
    "memory.profiles",
    "memory.stats",
    "memory.configure",
    "memory.enable",
    "memory.disable",
    "memory.prune",
    "memory.reindex",
]);
function broadcastNativeStatus() {
    void updateVersionBadge();
    const payload = { type: "NATIVE_STATUS", status: { ...hostStatus } };
    for (const port of statusPorts) {
        try {
            port.postMessage(payload);
        }
        catch {
            statusPorts.delete(port);
        }
    }
}
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup-status")
        return;
    statusPorts.add(port);
    try {
        port.postMessage({ type: "STATUS_SNAPSHOT", status: { ...hostStatus } });
    }
    catch {
        statusPorts.delete(port);
        return;
    }
    port.onDisconnect.addListener(() => statusPorts.delete(port));
});
chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
    const parsed = popupMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (["GET_RUNTIME_UPDATES", "SET_RUNTIME_UPDATES"].includes(message?.type)) {
        if (sender.tab || sender.id !== chrome.runtime.id) {
            sendResponse({ error: "Open update settings from the extension panel" });
            return false;
        }
        rpc.request(message.type === "GET_RUNTIME_UPDATES" ? "runtime.updateStatus" : "runtime.updateConfigure", { enabled: message.enabled })
            .then(result => sendResponse({ result })).catch(() => sendResponse({ error: "Update settings unavailable. Update the local runtime once to enable automatic updates." }));
        return true;
    }
    if (["GET_UPLOAD_SETTINGS", "SET_UPLOAD_SETTINGS", "GET_UPLOAD_REQUEST", "RESOLVE_UPLOAD_REQUEST"].includes(message?.type)) {
        const upload = uploadMessageSchema.safeParse(message);
        if (!upload.success) { sendResponse({ error: "Invalid upload request" }); return false; }
        uploadConsent.message(upload.data, sender).then(result => sendResponse({ result })).catch(error => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SNOOZE_VERSION_NOTICE") {
        const notice = versionNotice(chrome.runtime.getManifest().version, hostStatus);
        if (!notice) {
            sendResponse({ ok: true });
            return false;
        }
        const reminder = { key: notice.key, until: Date.now() + 7 * 86400000 };
        storageSet({ [VERSION_REMINDER_KEY]: reminder }).then(() => {
            hostStatus.versionReminder = reminder;
            broadcastNativeStatus();
            sendResponse({ ok: true });
        }).catch(() => sendResponse({ ok: false }));
        return true;
    }
    if (message?.type === "MEMORY_CALL") {
        if (!message.method || !POPUP_MEMORY_METHODS.has(message.method)) {
            sendResponse({ ok: false, error: "Unsupported memory operation" });
            return false;
        }
        rpc.connect();
        rpc.request(message.method, message.params ?? {}, { timeoutMs: 60000 })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_HOST_STATUS" || message?.type === "GET_NATIVE_HOST_STATUS") {
        sendResponse({ status: hostStatus });
        return true;
    }
    if (message?.type === "GET_PROFILE") {
        profileMetadata()
            .then((profile) => sendResponse({ profile: publicProfile(profile) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_PROFILE_DETAILS") {
        profileMetadata()
            .then((profile) => sendResponse({ profile }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SET_PROFILE_LABEL") {
        setProfileLabel(message.label)
            .then((profile) => sendResponse({ profile: publicProfile(profile) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (["GET_DECISION_SETTINGS", "SET_DECISION_SETTINGS", "TEST_DECISION_CONNECTION", "REMOVE_DECISION_KEY"].includes(message?.type)) {
        const decisionMethods: Record<string, string> = { GET_DECISION_SETTINGS: "decision.status", SET_DECISION_SETTINGS: "decision.configure",
            TEST_DECISION_CONNECTION: "decision.saveAndTest", REMOVE_DECISION_KEY: "decision.removeKey" };
        const method = decisionMethods[message.type];
        if (!method)
            return false;
        rpc.request(method, message.type === "TEST_DECISION_CONNECTION" ? { settings: message.settings, ...(message.apiKey ? { apiKey: message.apiKey } : {}) } : message.type === "SET_DECISION_SETTINGS" ? message.settings ?? {} : {})
            .then((result) => sendResponse({ result }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_SEMANTIC_SETTINGS") {
        rpc.request("semantic.status", {})
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_SEMANTIC_DIAGNOSTICS") {
        rpc.request("semantic.cacheDiagnostics", {})
            .then((diagnostics) => sendResponse({ diagnostics }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SET_SEMANTIC_SETTINGS") {
        rpc.request("semantic.setSettings", {
            enabled: message.enabled === true,
            modelId: typeof message.modelId === "string" ? message.modelId : undefined,
            preload: message.preload === true,
            embeddingDims: Number.isInteger(message.embeddingDims) ? message.embeddingDims : undefined,
            strategyPreference: typeof message.strategyPreference === "string" ? message.strategyPreference : undefined,
            agentResultCount: Number.isInteger(message.agentResultCount) ? message.agentResultCount : undefined,
            agentResultDetail: typeof message.agentResultDetail === "string" ? message.agentResultDetail : undefined,
        })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "PREPARE_SEMANTIC_MODEL") {
        rpc.request("semantic.prepareModel", { modelId: typeof message.modelId === "string" ? message.modelId : undefined })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "DELETE_SEMANTIC_MODEL") {
        rpc.request("semantic.deleteModel", { modelId: typeof message.modelId === "string" ? message.modelId : undefined })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "OPENCODE_CURSOR_ARRIVED") {
        const tabId = sender.tab?.id;
        const cursorId = typeof message.cursorId === "string" && message.cursorId.length > 0 ? message.cursorId : "default";
        const moveSequence = message.moveSequence;
        if (tabId !== undefined && Number.isInteger(tabId) && moveSequence !== undefined) {
            const waiter = cursorArrivalWaiters.get(cursorWaiterKey(tabId, cursorId, moveSequence));
            if (waiter)
                waiter();
        }
        sendResponse({ ok: true });
        return true;
    }
    if (message?.type === "OPENCODE_GET_CURSOR_STATE") {
        const tabId = sender.tab?.id;
        const states = tabId !== undefined && Number.isInteger(tabId) ? currentCursorStates(tabId) : [];
        sendResponse({ state: states[0] ?? null, states });
        return true;
    }
    return false;
});
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
