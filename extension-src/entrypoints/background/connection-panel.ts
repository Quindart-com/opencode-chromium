import type { NativeRpc } from "./native-rpc.ts";

/** Connection controls are restricted to our panel, never content scripts or pages. */
export async function connectionPanelMessage(message: { type: string; params?: Record<string, unknown>; enabled?: unknown }, sender: { id?: string; tab?: { url?: string }; url?: string; frameId?: number }, dependencies: {
  extensionId: string; panelUrl?: string; rpc: NativeRpc; idle(): boolean;
}) {
  const ownPanelTab = dependencies.panelUrl && sender.url === dependencies.panelUrl && sender.tab?.url === dependencies.panelUrl && sender.frameId === 0;
  if (sender.id !== dependencies.extensionId || sender.tab && !ownPanelTab) throw new Error("Open connection controls from the extension panel");
  if (message.type === "GET_HARNESS_CONNECTIONS") return dependencies.rpc.request("connections.list", {}, { timeoutMs: 2500 });
  if (message.type === "GET_RUNTIME_UPDATES") return dependencies.rpc.request("runtime.updateStatus", {});
  if (message.type === "SET_RUNTIME_UPDATES") return dependencies.rpc.request("runtime.updateConfigure", { enabled: message.enabled });
  const actions: Record<string, string> = { START_HARNESS_RECONNECT: "connections.reconnect", RUN_CONNECTION_DOCTOR: "connections.diagnose", INSTALL_RUNTIME_UPDATE: "runtime.updateNow", GET_LOCAL_ACTION: "runtime.actionStatus" };
  if (actions[message.type]) return dependencies.rpc.request(actions[message.type]!, message.params ?? {}, { timeoutMs: 3000 });
  if (!dependencies.idle() || !dependencies.rpc.idle()) throw new Error("Finish browser work before reconnecting. Your tabs and provider keys will stay saved.");
  if (message.type === "RECONNECT_NATIVE_HOST") { dependencies.rpc.reconnect(); return { reconnecting: true }; }
  if (message.type === "DISCONNECT_HARNESS") return dependencies.rpc.request("connections.disconnect", { id: message.params?.id }, { timeoutMs: 2500 });
  throw new Error("Unknown connection control");
}
