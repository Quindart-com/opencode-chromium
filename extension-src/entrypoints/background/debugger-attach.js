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
