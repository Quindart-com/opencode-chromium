import assert from "node:assert/strict";
import { test } from "bun:test";
import { AGENT_WORLD_NAME, createAgentWorld } from "../../src/browser/agent-world.ts";

function harness({ worldId = () => 7, evaluate } = {}) {
  const calls = [];
  let nextWorld = 0;
  const cdp = async (_context, _tab, method, params) => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: worldId(nextWorld++) };
    if (method === "Runtime.evaluate") return evaluate ? evaluate(params, calls) : { result: { value: "ok" } };
    return {};
  };
  const world = createAgentWorld({ cdp, key: (context, tabId) => `${context.sessionId}:${tabId}` });
  return { calls, world, context: { sessionId: "s" } };
}

test("plain evaluation never sends Runtime.enable and runs in a named isolated world", async () => {
  const { calls, world, context } = harness();
  assert.equal(await world.evaluate(context, 1, "1+1"), "ok");
  assert.equal(await world.evaluate(context, 1, "2+2"), "ok");
  assert.equal(calls.some(call => /\.enable$/.test(call.method)), false);
  const created = calls.filter(call => call.method === "Page.createIsolatedWorld");
  assert.equal(created.length, 1, "the context is cached for the tab and document");
  assert.deepEqual(created[0].params, { frameId: "main-frame", worldName: AGENT_WORLD_NAME, grantUniveralAccess: false });
  const evaluations = calls.filter(call => call.method === "Runtime.evaluate");
  assert.deepEqual(evaluations.map(call => call.params.contextId), [7, 7]);
});

test("page-world expressions use the default context and skip world creation", async () => {
  const { calls, world, context } = harness();
  await world.evaluate(context, 1, "navigator.modelContext", { world: "page" });
  assert.deepEqual(calls.map(call => call.method), ["Runtime.evaluate"]);
  assert.equal("contextId" in calls[0].params, false);
});

test("frame-routed evaluations keep the extension's frame world", async () => {
  const { calls, world } = harness();
  await world.evaluate({ sessionId: "s", frameId: "child" }, 1, "1");
  assert.deepEqual(calls.map(call => call.method), ["Runtime.evaluate"]);
  assert.equal("contextId" in calls[0].params, false);
});

test("a context that no longer exists is recreated once and the evaluation retried", async () => {
  let failed = false;
  const { calls, world, context } = harness({
    worldId: index => 10 + index,
    evaluate: params => {
      if (params.contextId === 10 && !failed) { failed = true; throw new Error("Cannot find context with specified id"); }
      return { result: { value: params.contextId } };
    },
  });
  assert.equal(await world.evaluate(context, 1, "x"), 11);
  assert.equal(calls.filter(call => call.method === "Page.createIsolatedWorld").length, 2);
  assert.equal(calls.filter(call => call.method === "Page.getFrameTree").length, 2, "the frame id is refreshed with the context");
});

test("a second missing-context failure is reported instead of looping", async () => {
  const { calls, world, context } = harness({ evaluate: () => { throw new Error("Cannot find context with specified id"); } });
  await assert.rejects(world.evaluate(context, 1, "x"), /Cannot find context/);
  assert.equal(calls.filter(call => call.method === "Runtime.evaluate").length, 2);
});

test("a context destroyed mid-evaluation is never replayed, but the next call recreates it", async () => {
  let destroyed = true;
  const { calls, world, context } = harness({
    worldId: index => 20 + index,
    evaluate: params => {
      if (destroyed) { destroyed = false; throw new Error("Execution context was destroyed."); }
      return { result: { value: params.contextId } };
    },
  });
  await assert.rejects(world.evaluate(context, 1, "x"), /destroyed/);
  assert.equal(calls.filter(call => call.method === "Runtime.evaluate").length, 1);
  assert.equal(await world.evaluate(context, 1, "x"), 21);
});

test("hosts that cannot expose a numeric context fall back to the main world once", async () => {
  const { calls, world, context } = harness({ worldId: () => "frame-context:main-frame:3" });
  await world.evaluate(context, 1, "x");
  await world.evaluate(context, 1, "y");
  assert.equal(calls.filter(call => call.method === "Page.createIsolatedWorld").length, 1);
  assert.equal(calls.filter(call => call.method === "Runtime.evaluate").every(call => !("contextId" in call.params)), true);
});

test("a host that refuses raw context ids keeps the main-world behavior", async () => {
  const refuse = Object.assign(new Error("Use a discovered frameId to select an owned execution context."), { code: "UNSUPPORTED_FRAME" });
  const { calls, world, context } = harness({ evaluate: params => { if ("contextId" in params) throw refuse; return { result: { value: "main" } }; } });
  assert.equal(await world.evaluate(context, 1, "x"), "main");
  assert.equal(await world.evaluate(context, 1, "y"), "main");
  assert.equal(calls.filter(call => call.method === "Page.createIsolatedWorld").length, 1);
});

test("forgetting a tab drops its cached context", async () => {
  const { calls, world, context } = harness();
  await world.evaluate(context, 1, "x");
  world.forgetTab("s", 1);
  await world.evaluate(context, 1, "x");
  assert.equal(calls.filter(call => call.method === "Page.createIsolatedWorld").length, 2);
});

test("page exceptions surface as errors", async () => {
  const { world, context } = harness({ evaluate: () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } } }) });
  await assert.rejects(world.evaluate(context, 1, "throw 1"));
});
