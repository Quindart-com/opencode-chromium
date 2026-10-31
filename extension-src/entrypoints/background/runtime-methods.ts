import type { Browser } from "wxt/browser";
import { browser as chrome } from "wxt/browser";
import { z } from "zod/mini";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import { record } from "../../../src/shared/values.ts";
import { registerDownloadHandlers } from "./download-events.ts";
import { finalizeOwnedTabs } from "./finalize-session.ts";
import { registerDecisionImageCapture } from "./firefox-bridge.ts";
import { NativeRpc } from "./native-rpc.ts";
import { reconcileAbandonedSessions } from "./reconcile-sessions.ts";
import { groupReviewTabs } from "./review-group.ts";
import { isBrowserInternalUrl } from "./tab-ownership.ts";
import type { BackgroundRuntimeDependencies as Dependencies } from "./types.ts";

export function registerRuntimeMethods(dependencies: Dependencies) {
  const rpc = dependencies.rpc as NativeRpc;
  const { profileMetadata, setProfileLabel, attachTab, detachTab, executeCdp, executeInputGesture, resolveTabActivation, moveMouse, framePoint, tabIdFromParams, cursorIdFromParams, cursorArrivalWaiters, cursorWaiterKey, cdpEventsByTabId, traceBuffers, requiredSessionId, sessionState, updateTurn, focusedNormalWindowId, creationRequestIds, trackTab, getTab, assertClaimableTab, normalizeTab, queryTabs, isClaimableTab, findTabOwner, assertSessionUrl, untrackTab, ensureControlledTab, hideCursor, ungroupTab, persistSessions, normalizeKeepItem, commandHealth, sessions, SESSION_GROUP_COLOR, downloadEvents, IS_FIREFOX, attachedTabs, recordCdpEvent, sendCdpCommand, HOST_NAME, focusTab, nowIso, uploadConsent, reconciliationToken } = dependencies;
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
    return attachTab(tabId, sessionId, params.deadlineAt);
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
rpc.register("framePoint", framePoint);
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
        events = events.filter((event: { method: string }) => methods.has(event.method));
    if (prefix)
        events = events.filter((event: { method: string }) => event.method.startsWith(prefix));
    return { events: events.slice(-limit), dialogs: { open: commandHealth.dialog(tabId) ? [{ tabId, ...commandHealth.dialog(tabId) }] : [] }, health: commandHealth.snapshot([tabId])[0] };
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
    if (params.creationRequestId) creationRequestIds.set(tab.id, params.creationRequestId);
    await trackTab(id, tab.id, "agent");
    return normalizeTab(tab);
});
rpc.register("claimUserTab", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    updateTurn(session, params);
    const tabId = tabIdFromParams(params);
    const tab = await getTab(tabId);
    assertClaimableTab(tab, findTabOwner(tabId));
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
    return { tabs, health: commandHealth.snapshot(session.tabIds) };
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
    const normalized = tabs.filter((tab: Browser.tabs.Tab) => isClaimableTab(tab, tab.id === undefined ? null : findTabOwner(tab.id)))
        .sort((a: Browser.tabs.Tab, b: Browser.tabs.Tab) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 1000)
        .map((tab: Browser.tabs.Tab) => normalizeTab(tab, { tabGroup: null, claimable: true }));
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
    const result = await finalizeOwnedTabs(session, keep, { blocked: tabId => params.blockedTabs?.find(tab => tab.tabId === tabId)?.reason, dialog: tabId => commandHealth.dialog(tabId), detach: detachTab, hide: hideCursor,
      deliver: tabIds => groupReviewTabs(session, tabIds, chrome), untrack: tabId => untrackTab(id, tabId) });
    if (!session.tabIds.size) sessions.delete(id);
    await persistSessions().catch(() => {});
    return result;
});
rpc.register("runtime.reconcileSessions", async (params) => {
    const sessionIds = params.sessionIds ?? [];
    const inactiveBefore = params.inactiveBefore;
    const expectedToken = reconciliationToken();
    if (!expectedToken || params.reconciliationToken !== expectedToken) throw Object.assign(new Error("Abandoned-session reconciliation requires the stable controller"), { code: "CONTROLLER_AUTH_REQUIRED" });
    if (!Number.isFinite(inactiveBefore) || sessionIds.some(id => !id || id.length > 240)) throw new Error("Invalid abandoned-session reconciliation request");
    const result = await reconcileAbandonedSessions(sessions, sessionIds, Number(inactiveBefore), {
      idle: () => commandHealth.idle() && uploadConsent.idle(), dialog: tabId => commandHealth.dialog(tabId),
      detach: detachTab, hide: hideCursor, ungroup: ungroupTab, untrack: untrackTab,
    });
    await persistSessions().catch(() => {});
    return result;
});
rpc.register("turnEnded", async (params) => {
    const id = requiredSessionId(params);
    const session = sessionState(id);
    for (const tabId of [...session.tabIds]) {
        if (!commandHealth.dialog(tabId)) await detachTab(tabId).catch(() => {});
        await beforeDeadline(() => hideCursor(tabId), Date.now() + 500, { tabId, phase: "cursor cleanup" }).catch(() => {});
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
}
