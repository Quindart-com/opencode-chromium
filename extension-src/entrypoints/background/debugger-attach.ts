import type { Browser,WxtBrowser } from "wxt/browser";
import type { DebuggerDependencies,TraceBuffer } from "./types.ts";

export function createDebuggerAttacher({ withTabLock, attachedTabs, isBrowserInternalUrl, getTab, chromeCall: _chromeCall, chrome, DEBUGGER_VERSION, errorMessage, sendCdpCommand, DEFAULT_CDP_TIMEOUT_MS }: DebuggerDependencies) {
  return async function attachTab(tabId: number, sessionId: string) {
  return withTabLock(tabId, async () => {
    if (isBrowserInternalUrl((await getTab(tabId)).url)) throw new Error("Agents cannot control browser or extension UI");
    if (attachedTabs.has(tabId)) return {};
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    } catch (error) {
      if (/another debugger/i.test(errorMessage(error))) {
        throw new Error(`Cannot attach debugger to tab ${tabId}: another debugger is already attached`, { cause: error });
      }
      throw error;
    }
    attachedTabs.set(tabId, sessionId);
    try {
      await sendCdpCommand(tabId, "Page.enable", {}, DEFAULT_CDP_TIMEOUT_MS);
      await sendCdpCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, DEFAULT_CDP_TIMEOUT_MS);
    } catch (error) {
      attachedTabs.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
    return {};
  });
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
