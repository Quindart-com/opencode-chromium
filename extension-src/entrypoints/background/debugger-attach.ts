import type { Browser,WxtBrowser } from "wxt/browser";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { DebuggerDependencies,TraceBuffer } from "./types.ts";

export function createDebuggerAttacher({ withTabLock, attachedTabs, isBrowserInternalUrl, getTab, chrome, DEBUGGER_VERSION, errorMessage, sendCdpCommand, DEFAULT_CDP_TIMEOUT_MS, onAttached, generation, trackPending, keepAttached }: DebuggerDependencies) {
  return async function attachTab(tabId: number, sessionId: string, deadlineAt = Date.now() + DEFAULT_CDP_TIMEOUT_MS) {
  return withTabLock(tabId, async () => {
    const innerDeadline = deadlineAt - 25;
    if (isBrowserInternalUrl((await beforeDeadline(() => getTab(tabId), innerDeadline, { tabId, method: "attach", phase: "preflight", executionState: "not_started" })).url)) throw new Error("Agents cannot control browser or extension UI");
    if (attachedTabs.has(tabId)) return {};
    const epoch = generation?.(tabId);
    let expired = false;
    try {
      await beforeDeadline(() => {}, innerDeadline, { tabId, method: "attach", phase: "attach", executionState: "not_started" });
      const task = Promise.resolve(chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)).then(async () => {
        if (expired || generation && epoch !== generation(tabId)) await beforeDeadline(() => chrome.debugger.detach({ tabId }), Date.now() + 2000, { tabId, phase: "late attach cleanup" }).catch(() => {});
      });
      trackPending?.(tabId, task);
      await beforeDeadline(() => task, innerDeadline, { tabId, method: "attach", phase: "attach", executionState: "not_started" });
    } catch (error) {
      expired = true;
      if (/another debugger/i.test(errorMessage(error))) {
        throw new Error(`Cannot attach debugger to tab ${tabId}: another debugger is already attached`, { cause: error });
      }
      throw error;
    }
    if (generation && epoch !== generation(tabId)) throw new Error("Attachment expired while the tab changed");
    attachedTabs.set(tabId, sessionId);
    try {
      await beforeDeadline(() => sendCdpCommand(tabId, "Page.enable", {}, Math.max(1, innerDeadline - Date.now())), innerDeadline, { tabId, method: "Page.enable", phase: "attach setup", executionState: "not_started" });
      await beforeDeadline(() => sendCdpCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, Math.max(1, innerDeadline - Date.now())), innerDeadline, { tabId, method: "Page.setInterceptFileChooserDialog", phase: "attach setup", executionState: "not_started" });
      await onAttached?.(tabId, innerDeadline);
      if (generation && epoch !== generation(tabId)) throw new Error("Attachment expired during setup");
    } catch (error) {
      if (keepAttached?.(tabId)) throw error;
      attachedTabs.delete(tabId);
      await beforeDeadline(() => chrome.debugger.detach({ tabId }), Date.now() + 2000, { tabId, phase: "detach", method: "attach cleanup" }).catch(() => {});
      throw error;
    }
    return {};
  }, deadlineAt, "attach");
  };
}

export function installChromiumEvents({ chrome, cdpEventTabId, traceBuffers, MAX_TRACE_CHUNKS, recordCdpEvent, attachedTabs }: {
  chrome: WxtBrowser;
  cdpEventTabId(source: Browser.debugger.Debuggee): number | null;
  traceBuffers: Map<number, TraceBuffer>;
  MAX_TRACE_CHUNKS: number;
  recordCdpEvent(source: Browser.debugger.Debuggee, method: string, params: object | undefined): void;
  attachedTabs: Map<number, string>;
}) {
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = cdpEventTabId(source);
  if (tabId !== null && Number.isInteger(tabId)) {
    const buffer = traceBuffers.get(tabId);
    if (buffer && method === "Tracing.dataCollected") {
      if (params && "value" in params && Array.isArray(params.value)) {
        for (const value of params.value) {
          buffer.chunks.push(typeof value === "string" ? value : JSON.stringify(value));
          buffer.eventCount += 1;
          if (buffer.chunks.length >= MAX_TRACE_CHUNKS) buffer.overflowed = true;
        }
      }
      return;
    }
    if (buffer && method === "Tracing.tracingComplete") {
      buffer.complete = true;
      if (params && "timestamp" in params && typeof params.timestamp === "number") buffer.endTime = params.timestamp;
      return;
    }
  }
  recordCdpEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined && Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
});

}
