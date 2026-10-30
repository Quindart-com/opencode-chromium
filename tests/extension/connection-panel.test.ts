import { expect,test } from "bun:test";
import { connectionPanelMessage } from "../../extension-src/entrypoints/background/connection-panel.ts";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";

test("a native port is only connecting until its first successful host response, and reconnect ignores old-port callbacks", async () => {
  const ports: any[] = [], states: string[] = [];
  const chrome = { runtime: { connectNative() { const port = { message: (_: unknown) => {}, disconnected: () => {}, onMessage: { addListener(fn: any) { port.message = fn; } }, onDisconnect: { addListener(fn: any) { port.disconnected = fn; } }, postMessage(message: any) { queueMicrotask(() => port.message({ id: message.id, result: "pong" })); }, disconnect() { port.disconnected(); } }; ports.push(port); return port; } } };
  const rpc = new NativeRpc({ chrome: chrome as any, hostName: "fixture", timeoutMs: 100, status: patch => { if (patch.state) states.push(patch.state); }, connected() {}, disconnected() {} });
  rpc.connect(); expect(states.at(-1)).toBe("connecting");
  await rpc.request("ping", {}); expect(states.at(-1)).toBe("connected");
  rpc.reconnect(); expect(ports).toHaveLength(2); expect(states.at(-1)).toBe("connecting");
  ports[0].disconnected(); expect(states.at(-1)).toBe("connecting");
  await rpc.request("ping", {}); expect(states.at(-1)).toBe("connected");
  ports[1].postMessage = () => {};
  rpc.heartbeat();
  ports[1].disconnected();
  rpc.reconnect(); expect(ports).toHaveLength(3);
  await Promise.resolve(); await Promise.resolve();
  expect(states.at(-1)).toBe("connecting");
  await rpc.request("ping", {}); expect(states.at(-1)).toBe("connected");
});

test("connection controls reject website callers and refuse reconnects during browser work", async () => {
  let reconnected = false;
  const rpc = { idle: () => true, reconnect() { reconnected = true; }, request: async () => ({ clients: [] }) } as unknown as NativeRpc;
  const dependencies = { rpc, extensionId: "fixture", idle: () => false };
  await expect(connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture", tab: {} }, dependencies)).rejects.toThrow("extension panel");
  await expect(connectionPanelMessage({ type: "RECONNECT_NATIVE_HOST" }, { id: "fixture" }, dependencies)).rejects.toThrow("Finish browser work");
  expect(reconnected).toBe(false);
  const panelUrl = "chrome-extension://fixture/popup.html";
  await expect(connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture", tab: { url: "https://fixture.test" }, url: panelUrl, frameId: 2 }, { ...dependencies, panelUrl })).rejects.toThrow("extension panel");
  expect(await connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture", tab: { url: panelUrl }, url: panelUrl, frameId: 0 }, { ...dependencies, panelUrl })).toEqual({ clients: [] });
  await connectionPanelMessage({ type: "RECONNECT_NATIVE_HOST" }, { id: "fixture" }, { ...dependencies, idle: () => true });
  expect(reconnected).toBe(true);
});
