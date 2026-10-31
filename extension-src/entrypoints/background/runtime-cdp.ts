import type { Browser } from "wxt/browser";
import type { CdpMethod,CdpParams,CdpRequest,CdpResult } from "../../../src/shared/cdp.ts";
import { pageException } from "../../../src/shared/page-error.ts";
import type { CommandParams } from "./command-schema.ts";
import { cursorState } from "./cursor-state.ts";
import type { BackgroundRuntimeDependencies as Dependencies } from "./types.ts";

export function createCdpRuntime(dependencies: Dependencies) {
  const { DEFAULT_CDP_TIMEOUT_MS, IS_FIREFOX, attachedTabs, chrome, record, beforeDeadline, commandHealth, queryTabs, tabIdFromParams, ensureControlledTab, assertSessionUrl, getTab, firefoxFrameRouting, frameRouting, withTabLock, guardedCdp, uploadConsent, uploadTargetUrl, sendCdpCommand, cursorIdFromParams, finiteNumber, gestureAction, publishCursorState, partialDispatchError, attachTab, cursorStateByTabId, framePoint, cursorStatesForTab } = dependencies;
function commandTimeoutMs(params: CommandParams): number {
    const timeoutMs = params.timeoutMs ?? params.timeout_ms ?? DEFAULT_CDP_TIMEOUT_MS;
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CDP_TIMEOUT_MS;
}
function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function executeCdp(params: CommandParams) {
    const method = params.method;
    if (typeof method !== "string" || method.length === 0)
        throw new Error("Expected CDP method");
    if (method === "Target.getTargets") {
        if (IS_FIREFOX)
            return { targetInfos: (await queryTabs({})).map((tab: Browser.tabs.Tab) => ({ targetId: String(tab.id), type: "page", url: tab.url, title: tab.title })) };
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
        throw Object.assign(new Error("Debugger unattached"), { code: "DEBUGGER_DETACHED", executionState: "not_started", uncertain: false });
    const deadlineAt = params.deadlineAt ?? Date.now() + commandTimeoutMs(params);
    const send = (command: object) => IS_FIREFOX
      ? firefoxFrameRouting.command(tabId, method, command, params.frameId, (url: string) => assertSessionUrl(session, url), deadlineAt - Date.now())
      : frameRouting.command(tabId, method, command, params.frameId, (url: string) => assertSessionUrl(session, url), deadlineAt - Date.now());
    const inspect: CdpRequest = async <K extends CdpMethod>(inspectMethod: K, inspectParams: CdpParams<K>) =>
      await (IS_FIREFOX ? firefoxFrameRouting : frameRouting).command(tabId, inspectMethod, inspectParams, params.frameId, (url: string) => assertSessionUrl(session, url), deadlineAt - Date.now()) as CdpResult<K>;
    if (method === "Page.handleJavaScriptDialog") {
      const result = await beforeDeadline(() => sendCdpCommand(tabId, method, params.commandParams ?? params.command_params ?? {}, Math.max(1, deadlineAt - Date.now()), commandHealth.dialog(tabId)?.sessionId), deadlineAt, { tabId, method, phase: "dialog recovery" });
      commandHealth.event(tabId, "Page.javascriptDialogClosed", {});
      return result;
    }
    if (commandHealth.dialog(tabId)) throw Object.assign(new Error("A native browser dialog is open. Read events and use handleDialog before continuing."), { code: "DIALOG_OPEN", executionState: "not_started", uncertain: false, details: { tabId, method, phase: "preflight", dialogType: commandHealth.dialog(tabId)?.type } });
    return withTabLock(tabId, () => guardedCdp({ method, tabId, consent: uploadConsent, getTab,
        inspectTarget: (uploadMethod: string, command: Record<string, unknown>) => uploadTargetUrl(uploadMethod, command, inspect),
        commandParams: params.commandParams ?? params.command_params ?? {}, send,
    }), deadlineAt, method);
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
    const deadlineAt = params.deadlineAt ?? Date.now() + methodTimeoutMs;
    await attachTab(tabId, sessionId, deadlineAt);
    let moveSequence = cursorStateByTabId.get(tabId)?.get(cursorId)?.moveSequence ?? 0;
    return withTabLock(tabId, async () => {
        const results = [];
        const hasCursorSteps = steps.some((s) => s.cursor && Number.isFinite(s.cursor.x) && Number.isFinite(s.cursor.y));
        const cursorPublishInterval = hasCursorSteps && steps.length > 20 ? Math.max(1, Math.floor(steps.length / 20)) : 1;
        let stepIndex = 0;
        let pointerDown = false;
        try {
        for (const step of steps) {
            await beforeDeadline(() => {}, deadlineAt, { tabId, method: step.method, phase: "gesture", executionState: results.length ? "unknown" : "not_started" });
            stepIndex += 1;
            const isLast = stepIndex === steps.length;
            const commandParams = step.commandParams ?? step.command_params ?? {};
            const action = gestureAction(step, pointerDown);
            if (step.cursor && Number.isFinite(step.cursor.x) && Number.isFinite(step.cursor.y)) {
                moveSequence += 1;
                const point = params.frameId ? await framePoint({ ...params, ...step.cursor }) : step.cursor;
                const patch = cursorState({
                    cursorId,
                    session,
                    x: point.x,
                    y: point.y,
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
                    inspectTarget: (method: string, command: Record<string, unknown>) => uploadTargetUrl(method, command, (nestedMethod: string, nestedCommand: object) => sendCdpCommand(tabId, nestedMethod, nestedCommand, DEFAULT_CDP_TIMEOUT_MS)),
                    commandParams,
                    send: async (command: object) => {
                      const result = await (IS_FIREFOX ? firefoxFrameRouting : frameRouting).command(tabId, step.method, command, params.frameId, (url: string) => assertSessionUrl(session, url), deadlineAt - Date.now());
                      const exception = record(result).exceptionDetails;
                      if (exception) throw pageException(exception);
                      return result;
                    },
                }));
            }
            const delayMs = Number(step.delayMs ?? step.delay_ms ?? 0);
            if (delayMs > 0)
                await sleep(Math.min(delayMs, 1000));
        }
        } catch (error) { throw partialDispatchError(error, results.length); }
        return { results, cursorId, moveSequence };
    }, deadlineAt, "inputGesture");
}
  return { executeCdp, executeInputGesture };
}
