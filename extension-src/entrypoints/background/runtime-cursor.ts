import { z } from "zod/mini";
import type { CommandParams } from "./command-schema.ts";
import type { CursorState } from "./cursor-state.ts";
import { CURSOR_SCRIPTS,cursorIdFromParams,cursorState } from "./cursor-state.ts";
import type { BackgroundRuntimeDependencies as Dependencies } from "./types.ts";

export function createCursorRuntime(dependencies: Dependencies) {
  const { chrome, cursorInjectedTabs, cursorArrivalWaiters, cursorStatesForTab, tabIdFromParams, ensureControlledTab, IS_FIREFOX, firefoxFrameRouting, frameRouting, assertSessionUrl, cursorStateByTabId, finiteNumber } = dependencies;
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
async function framePoint(params: CommandParams) {
    const tabId = tabIdFromParams(params);
    const { session } = ensureControlledTab(params, tabId);
    const point = { x: params.x ?? 0, y: params.y ?? 0 };
    if (!params.frameId || params.frameId === "main") return point;
    if (IS_FIREFOX) return z.object({ x: z.number(), y: z.number() }).parse(await firefoxFrameRouting.command(tabId, "OpenCode.framePoint", point, params.frameId, (url: string) => assertSessionUrl(session, url), 5000));
    return frameRouting.viewportPoint(tabId, params.frameId, point, (url: string) => assertSessionUrl(session, url));
}
async function moveMouse(params: CommandParams) {
    if (params.frameId) params = { ...params, ...await framePoint(params) };
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
    if (!states?.size && !cursorInjectedTabs.has(tabId)) return;
    const ids = cursorId ? [cursorId] : [...(states?.keys() ?? ["default"])];
    for (const id of ids) {
        const previous = states?.get(id) ?? { x: -100, y: -100, moveSequence: 0, cursorId: id, label: id, visible: false };
        await publishCursorState(tabId, { ...previous, cursorId: id, visible: false, moveSequence: previous.moveSequence + 1 });
    }
}
  return { injectCursor, cursorWaiterKey, waitForCursorArrival, publishCursorState, framePoint, moveMouse, hideCursor };
}
