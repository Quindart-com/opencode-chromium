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
  const reply = async (id: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = replies.find(row => row.id === id);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("No reply for " + id);
  };
  expect((await reply(2)).result.idle).toBe(false);
  finish(); await reply(1);
  receive({ jsonrpc: "2.0", id: 3, method: "runtime.canReconnect", params: {} });
  expect((await reply(3)).result.idle).toBe(true);
});

test("timed out handlers remain active until the underlying work finishes", async () => {
  let receive: (message: unknown) => void = () => {};
  const replies: any[] = [];
  const port = { onMessage: { addListener(callback: typeof receive) { receive = callback; } }, onDisconnect: { addListener() {} }, postMessage(message: unknown) { replies.push(message); } };
  const rpc = new NativeRpc({ chrome: { runtime: { connectNative: () => port } } as any, hostName: "fixture", timeoutMs: 1000, status() {}, connected() {}, disconnected() {} });
  let finish: () => void = () => {};
  rpc.register("slow", async () => new Promise<void>(resolve => { finish = resolve; }));
  rpc.connect();
  receive({ jsonrpc: "2.0", id: 1, method: "slow", params: { deadlineAt: Date.now() + 1 } });
  for (let attempt = 0; attempt < 200 && !replies.length; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(replies[0]?.error?.data?.uncertain).toBe(true);
  expect(rpc.idle()).toBe(false);
  finish();
  for (let attempt = 0; attempt < 100 && !rpc.idle(); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(rpc.idle()).toBe(true);
});
