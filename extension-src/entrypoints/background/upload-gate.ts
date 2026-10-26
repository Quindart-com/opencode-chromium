import type { Browser } from "wxt/browser";
import type { CdpRequest } from "../../../src/shared/cdp.ts";
import type { CdpCommandParams } from "./command-schema.ts";
import type { createUploadConsent } from "./upload-consent.ts";

export async function uploadTargetUrl(method: string, params: CdpCommandParams, cdp: CdpRequest): Promise<string> {
  let objectId = params.objectId;
  let owned = false;
  if (!objectId) {
    if (method === "Input.dispatchDragEvent" && (typeof params.x !== "number" || typeof params.y !== "number")) throw new Error("Upload destination requires coordinates");
    const node = method === "Input.dispatchDragEvent" ? await cdp("DOM.getNodeForLocation", { x: params.x ?? 0, y: params.y ?? 0 }) : params;
    objectId = (await cdp("DOM.resolveNode", { ...(node.nodeId ? { nodeId: node.nodeId } : {}), ...(node.backendNodeId ? { backendNodeId: node.backendNodeId } : {}) })).object?.objectId;
    owned = true;
  }
  if (!objectId) throw new Error("Cannot identify upload destination");
  try {
    const result = await cdp("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { const doc=this.ownerDocument||this; if(doc!==document || this.nodeType===1&&!this.isConnected) throw Error('Detached upload target'); return doc.location.href; }", returnByValue: true });
    if (result.exceptionDetails || typeof result.result?.value !== "string") throw Object.assign(new Error("Upload target is detached or its document changed"), { code: "STALE_TARGET", uncertain: false, executionState: "not_started" });
    return result.result.value;
  } finally { if (owned) await cdp("Runtime.releaseObject", { objectId }).catch(() => {}); }
}
export async function guardedCdp<T>({ method, commandParams, tabId, consent, getTab, send, inspectTarget }: {
  method: string;
  commandParams: CdpCommandParams;
  tabId: number;
  consent: Pick<ReturnType<typeof createUploadConsent>, "withFiles">;
  getTab(tabId: number): Promise<Browser.tabs.Tab>;
  send(command: CdpCommandParams): Promise<T>;
  inspectTarget?(method: string, command: CdpCommandParams): Promise<string>;
}): Promise<T> {
  if (method.startsWith("Target.") && method !== "Target.getTargets") throw new Error("Direct target control is unavailable to browser agents");
  if (method === "Page.setInterceptFileChooserDialog" && commandParams.enabled !== true) throw new Error("Agents cannot enable the native file picker");
  if (method === "Page.navigate" && !/^(https?:\/\/|about:blank$)/i.test(commandParams.url ?? "")) throw new Error("Agents cannot navigate to browser or extension UI");
  const files = method === "DOM.setFileInputFiles" ? commandParams.files : method === "Input.dispatchDragEvent" ? commandParams.data?.files : null;
  if (!files?.length) return send(commandParams);
  if (!Array.isArray(files) || files.some(file => typeof file !== "string")) throw new Error("Invalid upload file list");
  const tab = await getTab(tabId);
  const destination = inspectTarget ? await inspectTarget(method, commandParams) : tab.url;
  if (!destination) throw new Error("Cannot identify upload destination");
  const url = new URL(destination);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Upload destination must be a website");
  return consent.withFiles(files, url.origin + url.pathname, async approvedFiles => {
    const current = await getTab(tabId);
    if (current.url !== tab.url || current.pendingUrl && current.pendingUrl !== tab.url) throw new Error("Upload destination changed while waiting for approval");
    if (inspectTarget && await inspectTarget(method, commandParams) !== destination) throw new Error("Upload destination changed while waiting for approval");
    return send(method === "DOM.setFileInputFiles" ? { ...commandParams, files: approvedFiles } :
      { ...commandParams, data: { ...commandParams.data, files: approvedFiles } });
  }, tabId);
}
