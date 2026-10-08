import { test, expect } from "bun:test";
import { FirefoxBackend, remoteValue, validateEndpoint } from "../../native-host/src/firefox/backend.js";

test("remote transport rejects non-loopback, authenticated, or ambiguous endpoints", () => {
  expect(validateEndpoint("ws://127.0.0.1:9223/session")).toBe("ws://127.0.0.1:9223/session");
  for (const endpoint of ["ws://localhost:9223/session", "ws://0.0.0.0:9223/session", "ws://127.0.0.1:9223/session?token=secret", "wss://127.0.0.1:9223/session", "ws://name:secret@127.0.0.1:9223/session"]) expect(() => validateEndpoint(endpoint)).toThrow();
});
test("duplicate URLs cannot substitute for a verified extension nonce", async () => {
  const backend = new FirefoxBackend(); backend.connect = async () => {};
  let markers = { first: "a".repeat(32), second: "b".repeat(32) };
  backend.send = async (method, p) => method === "browsingContext.getTree" ? { contexts: [{ context: "first", url: "https://same.test/" }, { context: "second", url: "https://same.test/" }] } : { result: { type: "string", value: markers[p.target?.context] } };
  await backend.attach(7, "b".repeat(32)); expect(backend.contexts.get(7)).toBe("second");
  await expect(backend.attach(8, "c".repeat(32))).rejects.toThrow("could not be verified");
  markers.first = markers.second;
  await expect(backend.attach(9, "b".repeat(32))).rejects.toThrow("could not be verified");
  expect([...backend.contexts.keys()]).toEqual([7]);
});
test("commands cannot use unclaimed tabs or objects from another tab", async () => {
  const backend = new FirefoxBackend(); backend.contexts.set(1, "owned"); backend.objects.set("node", { context: "other", sharedId: "node" });
  await expect(backend.command(2, "Runtime.evaluate", { expression: "1" })).rejects.toThrow("bridge required");
  await expect(backend.command(1, "DOM.setFileInputFiles", { objectId: "node", files: [] })).rejects.toThrow("Stale");
  await expect(backend.command(1, "Tracing.start")).rejects.toThrow("unsupported_capability");
});
test("trusted input uses BiDi actions and preserves pointer identity for dragging", async () => {
  const backend = new FirefoxBackend(); backend.contexts.set(3, "owned"); const calls = [];
  backend.send = async (method, p) => { calls.push({ method, p }); return {}; };
  await backend.command(3, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 });
  await backend.command(3, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  await backend.command(3, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 80, y: 90 });
  await backend.command(3, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  expect(calls.every(c => c.method === "input.performActions" && c.p.context === "owned" && c.p.actions[0].id === "opencode-pointer")).toBe(true);
  expect(calls.map(c => c.p.actions[0].actions[0].type)).toEqual(["pointerMove", "pointerDown", "pointerMove", "pointerUp"]);
});
test("remote values deserialize nested arrays and records", () => {
  expect(remoteValue({ type: "object", value: [["items", { type: "array", value: [{ type: "number", value: 2 }, { type: "null" }] }]] })).toEqual({ items: [2, null] });
});

test("finalizing one tab preserves another session and releases the last BiDi session", async () => {
  const backend = new FirefoxBackend(); const calls = [];
  backend.contexts.set(1, "first"); backend.contexts.set(2, "second");
  backend.sessionId = "owned-session"; backend.socket = { readyState: 1, close() { calls.push("socket.close"); } };
  backend.send = async method => { calls.push(method); return {}; };
  await backend.detach(1);
  expect(backend.contexts.get(2)).toBe("second");
  expect(calls.includes("session.end")).toBe(false);
  await backend.detach(2);
  expect(calls.filter(method => method === "session.end").length).toBe(1);
  expect(backend.sessionId).toBe(null);
});

test("reset removes only this tab's environment preloads", async () => {
  const backend = new FirefoxBackend(); const calls = [];
  backend.contexts.set(1, "first"); backend.contexts.set(2, "second");
  backend.environmentPreloads.set(1, ["one"]); backend.environmentPreloads.set(2, ["two"]);
  backend.send = async (method, params) => { calls.push({ method, params }); return {}; };
  await backend.command(1, "Emulation.clearDeviceMetricsOverride");
  expect(calls[0]).toEqual({ method: "script.removePreloadScript", params: { script: "one" } });
  expect(backend.environmentPreloads.get(2)).toEqual(["two"]);
  expect(calls.at(-1).params.context).toBe("first");
});
