import { test,expect } from "bun:test";
import { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";

test("extension idle probes see an unfinished handler without counting themselves", async () => {
  let receive: (message: unknown) => void = () => {};
  const replies: any[] = [];
  const port = { onMessage: { addListener(callback: typeof receive) { receive = callback; } }, onDisconnect: { addListener() {} }, postMessage(message: unknown) { replies.push(message); } };
  const rpc = new NativeRpc({ chrome: { runtime: { connectNative: () => port } } as any, hostName: "fixture", timeoutMs: 1000, status() {}, connected() {}, disconnected() {} });
  let finish: () => void = () => {};
  rpc.register("slow", async () => new Promise<void>(resolve => { finish = resolve; }));
  rpc.register("runtime.canReconnect", async () => ({ idle: rpc.idle() }));
  rpc.connect();
  receive({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
  receive({ jsonrpc: "2.0", id: 2, method: "runtime.canReconnect", params: {} });
  await Promise.resolve();
  expect(replies.find(value => value.id === 2).result.idle).toBe(false);
  finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  receive({ jsonrpc: "2.0", id: 3, method: "runtime.canReconnect", params: {} }); await Promise.resolve();
  expect(replies.find(value => value.id === 3).result.idle).toBe(true);
});
