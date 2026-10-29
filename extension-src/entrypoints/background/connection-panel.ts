import type { NativeRpc } from "./native-rpc.ts";

/** Connection controls are restricted to our panel, never content scripts or pages. */
export async function connectionPanelMessage(message: { type: string; params?: Record<string, unknown> }, sender: { id?: string; tab?: { url?: string }; url?: string; frameId?: number }, dependencies: {
  extensionId: string; panelUrl?: string; rpc: NativeRpc; idle(): boolean;
}) {
  const ownPanelTab = dependencies.panelUrl && sender.url === dependencies.panelUrl && sender.tab?.url === dependencies.panelUrl && sender.frameId === 0;
  if (sender.id !== dependencies.extensionId || sender.tab && !ownPanelTab) throw new Error("Open connection controls from the extension panel");
  if (message.type === "GET_HARNESS_CONNECTIONS") return dependencies.rpc.request("connections.list", {}, { timeoutMs: 2500 });
  if (!dependencies.idle() || !dependencies.rpc.idle()) throw new Error("Finish browser work before reconnecting. Your tabs and provider keys will stay saved.");
  if (message.type === "RECONNECT_NATIVE_HOST") { dependencies.rpc.reconnect(); return { reconnecting: true }; }
  if (message.type === "DISCONNECT_HARNESS") return dependencies.rpc.request("connections.disconnect", { id: message.params?.id }, { timeoutMs: 2500 });
  throw new Error("Unknown connection control");
}
