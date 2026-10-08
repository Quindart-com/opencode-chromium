export function createDebuggerAttacher({ withTabLock, attachedTabs, isBrowserInternalUrl, getTab, chromeCall, chrome, DEBUGGER_VERSION, errorMessage, sendCdpCommand, DEFAULT_CDP_TIMEOUT_MS }) {
  return async function attachTab(tabId, sessionId) {
  return withTabLock(tabId, async () => {
    if (isBrowserInternalUrl((await getTab(tabId)).url)) throw new Error("Agents cannot control browser or extension UI");
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
    try {
      await sendCdpCommand(tabId, "Page.enable", {}, DEFAULT_CDP_TIMEOUT_MS);
      await sendCdpCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, DEFAULT_CDP_TIMEOUT_MS);
    } catch (error) {
      attachedTabs.delete(tabId);
      await chromeCall(done => chrome.debugger.detach({ tabId }, done)).catch(() => {});
      throw error;
    }
    return {};
  });
  };
}

export function installChromiumEvents({ chrome, cdpEventTabId, traceBuffers, MAX_TRACE_CHUNKS, recordCdpEvent, attachedTabs }) {
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = cdpEventTabId(source);
  if (Number.isInteger(tabId)) {
    const buffer = traceBuffers.get(tabId);
    if (buffer && method === "Tracing.dataCollected") {
      if (Array.isArray(params.value)) {
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
      buffer.endTime = params.timestamp ?? buffer.endTime;
      return;
    }
  }
  recordCdpEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
});

}
