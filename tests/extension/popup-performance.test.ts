import { expect,test } from "bun:test";
import { connectionPanelMessage } from "../../extension-src/entrypoints/background/connection-panel.ts";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";
import { setMemoryFetcher,subscribeMemoryStatus } from "../../extension-src/entrypoints/popup/memoryStatusStore.ts";

function fakeChrome() {
  const ports: any[] = [];
  return { ports, chrome: { runtime: { connectNative() {
    const port: any = { message: (_: unknown) => {}, disconnected: () => {}, onMessage: { addListener(fn: any) { port.message = fn; } }, onDisconnect: { addListener(fn: any) { port.disconnected = fn; } },
      postMessage(message: any) { queueMicrotask(() => port.message({ id: message.id, result: "pong" })); }, disconnect() { port.disconnected(); } };
    ports.push(port); return port;
  } } } };
}

test("successful RPC responses report connected once, and again after a reconnect", async () => {
  const { chrome } = fakeChrome(); const states: string[] = [];
  const rpc = new NativeRpc({ chrome: chrome as any, hostName: "fixture", timeoutMs: 100, status: patch => { if (patch.state) states.push(patch.state); }, connected() {}, disconnected() {} });
  rpc.connect();
  await rpc.request("ping", {}); await rpc.request("ping", {}); await rpc.request("ping", {});
  expect(states.filter(state => state === "connected")).toHaveLength(1);
  const generation = rpc.connectionGeneration();
  rpc.reconnect();
  expect(rpc.connectionGeneration()).toBeGreaterThan(generation);
  await rpc.request("ping", {}); await rpc.request("ping", {});
  expect(states.filter(state => state === "connected")).toHaveLength(2);
});

test("control capabilities are cached per native connection", async () => {
  const calls: string[] = []; let generation = 1;
  const rpc = { connectionGeneration: () => generation, request: async (method: string) => { calls.push(method); return method === "control.capabilities" ? { protocolVersion: 2 } : { clients: [] }; } } as unknown as NativeRpc;
  const dependencies = { rpc, extensionId: "fixture", idle: () => true };
  for (let index = 0; index < 3; index++) await connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture" }, dependencies);
  expect(calls.filter(method => method === "control.capabilities")).toHaveLength(1);
  generation = 2;
  await connectionPanelMessage({ type: "GET_HARNESS_CONNECTIONS" }, { id: "fixture" }, dependencies);
  expect(calls.filter(method => method === "control.capabilities")).toHaveLength(2);
});

test("memory status consumers of one scope share a single poller and release it", async () => {
  const calls: string[] = [];
  setMemoryFetcher((async (method: string) => { calls.push(method); return method === "memory.profiles" ? { currentProfileId: "p", profiles: [] } : { enabled: true, counts: {}, quota_bytes: 1, purge_days: 7 }; }) as any);
  let notified = 0;
  const a = subscribeMemoryStatus({ scope: "current", selectedProfiles: [] }, () => notified++);
  const b = subscribeMemoryStatus({ scope: "current", selectedProfiles: [] }, () => {});
  await a.refresh();
  expect(calls.filter(method => method === "memory.stats").length).toBeLessThanOrEqual(2);
  expect(a.snapshot().status?.enabled).toBe(true);
  expect(b.snapshot()).toBe(a.snapshot());
  expect(notified).toBeGreaterThan(0);
  a.unsubscribe(); b.unsubscribe(); setMemoryFetcher(null);
});

test("a stuck memory call surfaces an error instead of loading forever", async () => {
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms && ms >= 5000 ? 5 : ms, ...rest);
  try {
    setMemoryFetcher((() => new Promise(() => {})) as any);
    const sub = subscribeMemoryStatus({ scope: "all", selectedProfiles: [] }, () => {});
    await sub.refresh();
    expect(sub.snapshot().error).toContain("timed out");
    sub.unsubscribe();
  } finally { (globalThis as any).setTimeout = realSetTimeout; setMemoryFetcher(null); }
});
