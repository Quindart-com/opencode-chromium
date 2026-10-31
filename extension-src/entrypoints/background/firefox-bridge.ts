import type { TabCdpRequest } from "../../../src/shared/cdp.ts";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import { record } from "../../../src/shared/values.ts";
import type { CommandParams } from "./command-schema.ts";
import { prepareJevScreenshot } from "./decision-image.ts";
import type { NativeRpc } from "./native-rpc.ts";
import type { AttachDependencies,TabOwner } from "./types.ts";

export function createFirefoxAttacher({ withTabLock, getTab, isBrowserInternalUrl, attachedTabs, chrome, rpc, generation, trackPending }: AttachDependencies & { rpc: Pick<NativeRpc, "request"> }) {
  return (tabId: number, sessionId: string, deadlineAt = Date.now() + 10000) => withTabLock(tabId, async () => {
    if (isBrowserInternalUrl((await getTab(tabId)).url)) throw new Error("Agents cannot control browser or extension UI");
    if (attachedTabs.has(tabId)) return {};
    const epoch = generation?.(tabId);
    const marker = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    await chrome.scripting.executeScript({ target: { tabId }, func: (value: string) => {
      document.documentElement.setAttribute("data-opencode-bidi-bridge", value);
      // Firefox has no CDP file chooser interception. Suppress the picker while
      // the controlled tab is attached; approved input.setFiles stays available.
      if (!globalThis.__opencodeFileGuard) {
        globalThis.__opencodeFileGuard = event => { if (event.composedPath().some(node => node instanceof HTMLInputElement && node.type === "file")) event.preventDefault(); };
        document.addEventListener("click", globalThis.__opencodeFileGuard, true);
      }
    }, args: [marker] });
    try {
      const task = rpc.request("firefox.attach", { tabId, marker, deadlineAt }, { timeoutMs: Math.max(1000, deadlineAt - Date.now() + 5000) }).then(async result => {
        if (Date.now() >= deadlineAt || generation && epoch !== generation(tabId)) { await rpc.request("firefox.detach", { tabId }, { timeoutMs: 2000 }).catch(() => {}); throw new Error("Firefox attachment expired during setup"); }
        return result;
      });
      trackPending?.(tabId, task);
      await beforeDeadline(() => task, deadlineAt, { tabId, phase: "attach", method: "firefox.attach", executionState: "not_started" });
      attachedTabs.set(tabId, sessionId); return {};
    }
    catch (error) { await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (globalThis.__opencodeFileGuard) document.removeEventListener("click", globalThis.__opencodeFileGuard, true); delete globalThis.__opencodeFileGuard; } }).catch(() => {}); throw error; }
    finally { await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.removeAttribute("data-opencode-bidi-bridge") }).catch(() => {}); }
  }, deadlineAt, "firefox.attach");
}
export function registerDecisionImageCapture({ rpc, tabIdFromParams, ensureControlledTab, getTab, isBrowserInternalUrl, attachTab, requiredSessionId, sendCdpCommand }: {
  rpc: Pick<NativeRpc, "register" | "request">;
  tabIdFromParams(params: CommandParams): number;
  ensureControlledTab(params: CommandParams, tabId: number): TabOwner;
  getTab: AttachDependencies["getTab"];
  isBrowserInternalUrl: AttachDependencies["isBrowserInternalUrl"];
  attachTab(tabId: number, sessionId: string): Promise<unknown>;
  requiredSessionId(params: CommandParams): string;
  sendCdpCommand: TabCdpRequest;
}) {
  rpc.register("decisionImage", async params => {
    const tabId = tabIdFromParams(params); ensureControlledTab(params, tabId);
    const before = await getTab(tabId);
    if (before.url !== params.pageUrl || isBrowserInternalUrl(before.url)) return {};
    const settings = record(await rpc.request("decision.status", {}));
    if (!settings.ready || (settings.provider !== "openai-decisions" && settings.provider !== "jev") || !settings.shareImages) return {};
    await attachTab(tabId, requiredSessionId(params));
    const stateExpression = "(()=>{let h=2166136261;for(const c of (document.body?.innerText??'').slice(0,32000))h=Math.imul(h^c.charCodeAt(0),16777619);return JSON.stringify([performance.timeOrigin,location.href,innerWidth,innerHeight,scrollX,scrollY,h])})()";
    const state = async () => (await sendCdpCommand(tabId, "Runtime.evaluate", { expression: stateExpression, returnByValue: true }, 250)).result?.value;
    if (!params.decisionState || await state() !== params.decisionState) return {};
    const capture = await sendCdpCommand(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 45 }, 750);
    const image = settings.provider === "jev" ? await prepareJevScreenshot(capture.data ?? "").catch(() => undefined) :
      capture.data && capture.data.length <= 399970 ? `data:image/jpeg;base64,${capture.data}` : undefined;
    const afterSettings = record(await rpc.request("decision.status", {}));
    if (!image || !afterSettings.ready || afterSettings.provider !== settings.provider || afterSettings.route !== settings.route || !afterSettings.shareImages || await state() !== params.decisionState || (await getTab(tabId)).url !== before.url) return {};
    return { image };
  });
}
