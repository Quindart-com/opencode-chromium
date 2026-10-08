export function createFirefoxAttacher({ withTabLock, getTab, isBrowserInternalUrl, attachedTabs, chromeCall, chrome, rpc }) {
  return (tabId, sessionId) => withTabLock(tabId, async () => {
    if (isBrowserInternalUrl((await getTab(tabId)).url)) throw new Error("Agents cannot control browser or extension UI");
    if (attachedTabs.has(tabId)) return {};
    const marker = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    await chromeCall(done => chrome.scripting.executeScript({ target: { tabId }, func: value => {
      document.documentElement.setAttribute("data-opencode-bidi-bridge", value);
      // Firefox has no CDP file chooser interception. Suppress the picker while
      // the controlled tab is attached; approved input.setFiles stays available.
      if (!globalThis.__opencodeFileGuard) {
        globalThis.__opencodeFileGuard = event => { if (event.composedPath().some(node => node instanceof HTMLInputElement && node.type === "file")) event.preventDefault(); };
        document.addEventListener("click", globalThis.__opencodeFileGuard, true);
      }
    }, args: [marker] }, done));
    try { await rpc.request("firefox.attach", { tabId, marker }); attachedTabs.set(tabId, sessionId); return {}; }
    catch (error) { await chromeCall(done => chrome.scripting.executeScript({ target: { tabId }, func: () => { document.removeEventListener("click", globalThis.__opencodeFileGuard, true); delete globalThis.__opencodeFileGuard; } }, done)).catch(() => {}); throw error; }
    finally { await chromeCall(done => chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.removeAttribute("data-opencode-bidi-bridge") }, done)).catch(() => {}); }
  });
}
export function registerDecisionImageCapture({ rpc, tabIdFromParams, ensureControlledTab, getTab, isBrowserInternalUrl, attachTab, requiredSessionId, sendCdpCommand }) {
  rpc.register("decisionImage", async params => {
    const tabId = tabIdFromParams(params); ensureControlledTab(params, tabId);
    const before = await getTab(tabId);
    if (before.url !== params.pageUrl || isBrowserInternalUrl(before.url)) return {};
    const settings = await rpc.request("decision.status", {});
    if (!settings.ready || settings.provider !== "openai-decisions" || !settings.shareImages) return {};
    await attachTab(tabId, requiredSessionId(params));
    const stateExpression = "(()=>{let h=2166136261;for(const c of (document.body?.innerText??'').slice(0,32000))h=Math.imul(h^c.charCodeAt(0),16777619);return JSON.stringify([performance.timeOrigin,location.href,innerWidth,innerHeight,scrollX,scrollY,h])})()";
    const state = async () => (await sendCdpCommand(tabId, "Runtime.evaluate", { expression: stateExpression, returnByValue: true }, 250)).result?.value;
    if (!params.decisionState || await state() !== params.decisionState) return {};
    const capture = await sendCdpCommand(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 45 }, 750);
    const afterSettings = await rpc.request("decision.status", {});
    if (!afterSettings.ready || afterSettings.provider !== "openai-decisions" || !afterSettings.shareImages || await state() !== params.decisionState || (await getTab(tabId)).url !== before.url || !capture.data || capture.data.length > 399970) return {};
    return { image: `data:image/jpeg;base64,${capture.data}` };
  });
}
