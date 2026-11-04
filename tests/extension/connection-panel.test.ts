import { expect,test } from "bun:test";
import { connectionPanelMessage } from "../../extension-src/entrypoints/background/connection-panel.ts";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";
import { requiresRuntimeSetup,runtimeSetupCommand } from "../../extension-src/runtime-update.ts";

test("legacy hosts expose one-time setup instead of an update action they cannot execute", async () => {
  const calls: string[] = [];
  const rpc = { request: async (method: string) => {
    calls.push(method);
    if (method === "control.capabilities") throw new Error("Method not found");
    if (method === "runtime.updateStatus") return { supported: true, installedVersion: "1.10.2" };
    throw new Error(`Unexpected mutation: ${method}`);
  } } as unknown as NativeRpc;
  const dependencies = { rpc, extensionId: "fixture", idle: () => true };
  const status = await connectionPanelMessage({ type: "GET_RUNTIME_UPDATES" }, { id: "fixture" }, dependencies);
  expect(requiresRuntimeSetup(status)).toBe(true);
  expect(status.reason).toContain(runtimeSetupCommand);
  const action = await connectionPanelMessage({ type: "INSTALL_RUNTIME_UPDATE" }, { id: "fixture" }, dependencies);
  expect(requiresRuntimeSetup(action)).toBe(true);
  expect(action.state).toBe("blocked");
  expect(calls).not.toContain("runtime.updateNow");
});

test("controller updates preserve approval and job polling, without replaying a rejected update", async () => {
  const calls: [string, unknown][] = [];
  const job = { id: "fixture-job", kind: "update", state: "queued", code: "queued", updatedAt: 1 };
  let rejectUpdate = false;
  const rpc = { request: async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "control.capabilities") return { protocolVersion: 2, methods: ["control.update", "control.job"] };
    if (method === "control.update" && rejectUpdate) throw new Error("Update rejected");
    return job;
  } } as unknown as NativeRpc;
  const dependencies = { rpc, extensionId: "fixture", idle: () => true };
  expect(await connectionPanelMessage({ type: "INSTALL_RUNTIME_UPDATE", params: { approvedMajor: true } }, { id: "fixture" }, dependencies)).toEqual(job);
  expect(await connectionPanelMessage({ type: "GET_LOCAL_ACTION", params: { id: job.id } }, { id: "fixture" }, dependencies)).toEqual(job);
  expect(calls).toContainEqual(["control.update", { approvedMajor: true }]);
  expect(calls).toContainEqual(["control.job", { id: job.id }]);
  rejectUpdate = true;
  await expect(connectionPanelMessage({ type: "INSTALL_RUNTIME_UPDATE" }, { id: "fixture" }, dependencies)).rejects.toThrow("Update rejected");
  expect(calls.filter(([method]) => method === "control.update")).toHaveLength(2);
  expect(calls.some(([method]) => method === "runtime.updateNow")).toBe(false);
});

test("a current controller is recognized even when its worker omits legacy harness inventory", async () => {
  const snapshot = { host: { version: "2.0.1", pid: 42 }, clients: [] };
  const rpc = { request: async (method: string) => method === "control.capabilities" ? { protocolVersion: 2 } : snapshot } as unknown as NativeRpc;
  const result = await connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture" }, { rpc, extensionId: "fixture", idle: () => true });
  expect(result).toEqual({ ...snapshot, controllerSupported: true });
});

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


test("trusted full-panel navigation retains connection controls on a selected view", async () => {
  const panelUrl = "chrome-extension://fixture/popup.html";
  const rpc = { request: async (method: string) => method === "control.capabilities" ? { protocolVersion: 2 } : { clients: [] } } as unknown as NativeRpc;
  const result = await connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture", url: panelUrl + "#settings", tab: { url: panelUrl + "#settings" }, frameId: 0 }, { extensionId: "fixture", panelUrl, rpc, idle: () => true });
  expect(result).toEqual({ clients: [], controllerSupported: true });
});
