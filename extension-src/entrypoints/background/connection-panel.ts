import type { NativeRpc } from "./native-rpc.ts";

/** Connection controls are restricted to our panel, never content scripts or pages. */
export async function connectionPanelMessage(message: { type: string; params?: Record<string, unknown>; enabled?: unknown }, sender: { id?: string; tab?: { url?: string }; url?: string; frameId?: number }, dependencies: {
  extensionId: string; panelUrl?: string; rpc: NativeRpc; idle(): boolean;
}) {
  const ownPanelTab = dependencies.panelUrl && sender.url === dependencies.panelUrl && sender.tab?.url === dependencies.panelUrl && sender.frameId === 0;
  if (sender.id !== dependencies.extensionId || sender.tab && !ownPanelTab) throw new Error("Open connection controls from the extension panel");
  const capabilities = async () => {
    try { return await dependencies.rpc.request("control.capabilities", {}, { timeoutMs: 1500 }) as { protocolVersion?: number; methods?: string[] }; }
    catch { return null; }
  };
  if (message.type === "GET_HARNESS_CONNECTIONS") return dependencies.rpc.request("connections.list", {}, { timeoutMs: 2500 });
  if (message.type === "GET_RUNTIME_UPDATES") {
    const supported = await capabilities();
    if (supported?.protocolVersion === 2) return dependencies.rpc.request("control.status", {}, { timeoutMs: 2500 });
    const legacy = await dependencies.rpc.request("runtime.updateStatus", {}, { timeoutMs: 2500 }).catch(() => null);
    return { ...(legacy && typeof legacy === "object" ? legacy : {}),supported: false,controllerSupported: false,state: "bridge_required",
      reason: "Run opencode-chromium setup --all once to install the stable update controller. The current runtime remains available." };
  }
  if (message.type === "SET_RUNTIME_UPDATES") {
    const supported = await capabilities();
    if (!supported?.methods?.includes("control.status")) return { supported: false,state: "bridge_required",reason: "Install the stable controller before changing update settings." };
    return dependencies.rpc.request("control.configure", { enabled: message.enabled });
  }
  if (message.type === "INSTALL_RUNTIME_UPDATE") {
    const supported = await capabilities();
    if (!supported?.methods?.includes("control.update")) return { id: "legacy-controller",kind: "update",state: "blocked",code: "bridge_required",updatedAt: Date.now() };
    return dependencies.rpc.request("control.update", message.params ?? {}, { timeoutMs: 3000 });
  }
  const actions: Record<string, string> = { START_HARNESS_RECONNECT: "control.reconnect", RUN_CONNECTION_DOCTOR: "control.diagnose", GET_LOCAL_ACTION: "control.job" };
  if (actions[message.type]) {
    const supported = await capabilities();
    if (!supported) return { id: "legacy-controller",kind: message.type === "START_HARNESS_RECONNECT" ? "reconnect" : "diagnose",state: "blocked",code: "bridge_required",updatedAt: Date.now() };
    return dependencies.rpc.request(actions[message.type]!, message.params ?? {}, { timeoutMs: 3000 });
  }
  if (!dependencies.idle() || !dependencies.rpc.idle()) throw new Error("Finish browser work before reconnecting. Your tabs and provider keys will stay saved.");
  if (message.type === "RECONNECT_NATIVE_HOST") { dependencies.rpc.reconnect(); return { reconnecting: true }; }
  if (message.type === "DISCONNECT_HARNESS") return dependencies.rpc.request("connections.disconnect", { id: message.params?.id }, { timeoutMs: 2500 });
  throw new Error("Unknown connection control");
}
