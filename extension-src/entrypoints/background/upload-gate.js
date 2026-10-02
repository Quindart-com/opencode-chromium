export async function uploadTargetUrl(method, params, cdp) {
  let objectId = params.objectId;
  let owned = false;
  if (!objectId) {
    const node = method === "Input.dispatchDragEvent" ? await cdp("DOM.getNodeForLocation", { x: params.x, y: params.y }) : params;
    objectId = (await cdp("DOM.resolveNode", { ...(node.nodeId ? { nodeId: node.nodeId } : {}), ...(node.backendNodeId ? { backendNodeId: node.backendNodeId } : {}) })).object?.objectId;
    owned = true;
  }
  if (!objectId) throw new Error("Cannot identify upload destination");
  try {
    const result = await cdp("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return (this.ownerDocument || this).location.href; }", returnByValue: true });
    if (result.exceptionDetails || typeof result.result?.value !== "string") throw new Error("Upload destination changed or cannot be verified");
    return result.result.value;
  } finally { if (owned) await cdp("Runtime.releaseObject", { objectId }).catch(() => {}); }
}
export async function guardedCdp({ method, commandParams, tabId, consent, getTab, send, inspectTarget }) {
  if (method.startsWith("Target.") && method !== "Target.getTargets") throw new Error("Direct target control is unavailable to browser agents");
  if (method === "Page.setInterceptFileChooserDialog" && commandParams.enabled !== true) throw new Error("Agents cannot enable the native file picker");
  if (method === "Page.navigate" && !/^(https?:\/\/|about:blank$)/i.test(commandParams.url ?? "")) throw new Error("Agents cannot navigate to browser or extension UI");
  const files = method === "DOM.setFileInputFiles" ? commandParams.files : method === "Input.dispatchDragEvent" ? commandParams.data?.files : null;
  if (!files?.length) return send(commandParams);
  if (!Array.isArray(files) || files.some(file => typeof file !== "string")) throw new Error("Invalid upload file list");
  const tab = await getTab(tabId);
  const destination = inspectTarget ? await inspectTarget(method, commandParams) : tab.url;
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
