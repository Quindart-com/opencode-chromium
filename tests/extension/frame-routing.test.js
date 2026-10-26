import assert from "node:assert/strict";
import test from "node:test";
import { FrameRouting } from "../../extension-src/entrypoints/background/frame-routing.ts";
import { FirefoxFrameRouting } from "../../extension-src/entrypoints/background/firefox-frame-routing.ts";

const tree = { frame: { id: "root", url: "https://parent.test" }, childFrames: [
  { frame: { id: "first", url: "https://embedded.test" } }, { frame: { id: "second", url: "https://embedded.test" } },
] };

test("Chromium routes duplicate-URL frames and their object references to owned child sessions", async () => {
  const calls = [];
  const router = new FrameRouting(async (tab, method, params, timeout, session) => {
    calls.push({ tab, method, params, session });
    if (method === "Page.getFrameTree") return { frameTree: session ? tree.childFrames[1] : tree };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 4 };
    if (method === "Runtime.evaluate") return { result: { objectId: "owned-child-node" } };
    return {};
  });
  router.event({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { type: "iframe" } });
  await router.command(1, "Runtime.evaluate", { expression: "document.querySelector('input')" }, "second", () => {}, 1000);
  await router.command(1, "DOM.describeNode", { objectId: "owned-child-node" }, undefined, () => {}, 1000);
  assert.equal(calls.find(call => call.method === "Runtime.evaluate").session, "child-session");
  assert.equal(calls.find(call => call.method === "Runtime.evaluate").params.contextId, 4);
  assert.equal(calls.find(call => call.method === "DOM.describeNode").session, "child-session");
  await assert.rejects(router.command(1, "Runtime.evaluate", { expression: "1", contextId: "frame-context:second:3" }, undefined, () => {}, 1000), { code: "STALE_TARGET" });
  await assert.rejects(router.command(1, "Runtime.evaluate", { expression: "1" }, "missing", () => {}, 1000), { code: "FRAME_NOT_FOUND" });
});

test("expired frame discovery never dispatches its delayed mutation", async () => {
  const calls = [];
  const router = new FrameRouting(async (tab, method) => {
    calls.push(method);
    await new Promise(resolve => setTimeout(resolve, 30));
    return { frameTree: tree };
  });
  await assert.rejects(router.command(1, "Runtime.evaluate", { expression: "document.body.click()" }, "first", () => {}, 5), { code: "TIMEOUT" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(calls, ["Page.getFrameTree"]);
});

test("Firefox applies the selected frame policy before acting and refuses arbitrary contexts", async () => {
  const calls = [];
  const router = new FirefoxFrameRouting(async (tab, method, params) => {
    calls.push({ method, params });
    return method === "Page.getFrameTree" ? { frameTree: tree } : { result: { value: 1 } };
  });
  await assert.rejects(router.command(1, "Runtime.evaluate", { expression: "1" }, "second", url => { if (url.includes("embedded")) throw Error("blocked origin"); }, 1000), /blocked origin/);
  assert.equal(calls.some(call => call.method === "Runtime.evaluate"), false);
  await assert.rejects(router.command(1, "Runtime.evaluate", { contextId: "unowned", expression: "1" }, undefined, () => {}, 1000), { code: "UNSUPPORTED_FRAME" });
  await router.command(1, "Runtime.evaluate", { expression: "1", agentFrameId: "untrusted" }, "first", () => {}, 1000);
  assert.equal(calls.at(-1).params.agentFrameId, "first");
});
