import assert from "node:assert/strict";
import test from "node:test";
import { createEnvironmentController } from "../../src/browser/environment.js";

function fixture() {
  const calls = [];
  let nextScriptId = 0;
  let failure;
  const controller = createEnvironmentController({
    keyFor: async (context, tabId) => `${context.sessionId}:${context.profileId}:${tabId}`,
    backend: { configure: async () => false, reset: async () => false },
    enableNetwork: async () => {},
    command: async (context, tabId, method, params) => {
      const call = { sessionId: context.sessionId, profileId: context.profileId, tabId, method, params };
      calls.push(call);
      if (failure?.(call)) throw new Error("Simulated command failure");
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `preload-${++nextScriptId}` } : {};
    },
  });
  return { controller, calls, fail: fn => { failure = fn; } };
}

const first = { sessionId: "first", profileId: "profile-one" };
const second = { sessionId: "second", profileId: "profile-one" };

test("reset removes only owned tab preloads and restores its user agent and headers", async () => {
  const { controller, calls } = fixture();
  await controller.apply(first, 7, { userAgent: "Example test agent", headers: { "X-Example": "test" }, initScripts: ["window.fixtureReady = true"] });
  await controller.apply(first, 8, { initScripts: ["window.fixtureReady = true"] });
  await controller.apply(second, 7, { initScripts: ["window.fixtureReady = true"] });
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls.map(call => call.method), [
    "Page.removeScriptToEvaluateOnNewDocument", "Emulation.setUserAgentOverride", "Network.setExtraHTTPHeaders",
  ]);
  assert.deepEqual(calls[0].params, { identifier: "preload-1" });
  assert.deepEqual(calls[1].params, { userAgent: "" });
  assert.deepEqual(calls[2].params, { headers: {} });
  assert.ok(calls.every(call => call.sessionId === "first" && call.tabId === 7));
  calls.length = 0;
  await controller.reset(first, 8);
  await controller.reset(second, 7);
  assert.deepEqual(calls.map(call => call.params.identifier), ["preload-2", "preload-3"]);
});

test("identical tab ids from different profiles retain independent cleanup records", async () => {
  const { controller, calls } = fixture();
  const otherProfile = { ...first, profileId: "profile-two" };
  await controller.apply(first, 7, { initScripts: ["window.one = true"] });
  await controller.apply(otherProfile, 7, { initScripts: ["window.two = true"] });
  calls.length = 0;
  await controller.reset(first, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.identifier, "preload-1");
  calls.length = 0;
  await controller.reset(otherProfile, 7);
  assert.equal(calls[0].params.identifier, "preload-2");
});

test("configuration failures propagate and partial overrides remain cleanable", async () => {
  const { controller, calls, fail } = fixture();
  fail(call => call.method === "Emulation.setUserAgentOverride" && call.params.userAgent !== "");
  await assert.rejects(controller.apply(first, 7, { colorScheme: "dark", userAgent: "Example test agent" }), /Simulated command failure/);
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls.map(call => call.params), [{}, { userAgent: "" }]);
});

test("cleanup continues after one failure and retry retains the unresolved script", async () => {
  const { controller, calls, fail } = fixture();
  await controller.apply(first, 7, { userAgent: "Example test agent", initScripts: ["window.fixtureReady = true"] });
  fail(call => call.method === "Page.removeScriptToEvaluateOnNewDocument");
  calls.length = 0;
  await assert.rejects(controller.reset(first, 7), /cleanup failed/);
  assert.equal(calls.some(call => call.method === "Emulation.setUserAgentOverride" && call.params.userAgent === ""), true);
  fail(undefined);
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls.map(call => call.method), ["Page.removeScriptToEvaluateOnNewDocument"]);
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls, []);
});

test("empty headers explicitly clear a prior configuration and repeat preloads all reset", async () => {
  const { controller, calls } = fixture();
  await controller.apply(first, 7, { headers: { "X-Example": "test" }, initScripts: ["window.firstFixture = true"] });
  await controller.apply(first, 7, { headers: {}, initScripts: ["window.secondFixture = true"] });
  assert.deepEqual(calls.findLast(call => call.method === "Network.setExtraHTTPHeaders").params, { headers: {} });
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls.filter(call => call.method === "Page.removeScriptToEvaluateOnNewDocument").map(call => call.params.identifier), ["preload-1", "preload-2"]);
});

test("an unacknowledged preload prevents a successful cleanup claim", async () => {
  const { controller, calls, fail } = fixture();
  fail(call => call.method === "Page.addScriptToEvaluateOnNewDocument");
  await assert.rejects(controller.apply(first, 7, { initScripts: ["window.uncertainFixture = true"] }), /Simulated command failure/);
  await assert.rejects(controller.reset(first, 7), /close the affected tab/);
  fail(undefined);
  await controller.apply(first, 7, { initScripts: ["window.knownFixture = true"] });
  calls.length = 0;
  await assert.rejects(controller.reset(first, 7), /close the affected tab/);
  assert.equal(calls[0].params.identifier, "preload-1");
  // Finalization forgets records only after the browser releases/closes its tabs.
  controller.forgetSession("first:");
  calls.length = 0;
  await controller.reset(first, 7);
  assert.deepEqual(calls, []);
});

test("Firefox configuration and reset stay delegated to its backend", async () => {
  const calls = [];
  const controller = createEnvironmentController({
    keyFor: async () => { throw new Error("Chromium bookkeeping should not run"); },
    command: async () => { throw new Error("Chromium commands should not run"); },
    backend: {
      configure: async (_context, tabId, env) => { calls.push({ tabId, env }); return true; },
      reset: async (_context, tabId) => { calls.push({ tabId, reset: true }); return true; },
    },
  });
  await controller.apply(first, 7, { viewport: { width: 400, height: 600 } });
  await controller.reset(first, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].reset, true);
});

test("network overrides enable the protocol domain before setting headers", async () => {
  const calls = [];
  const controller = createEnvironmentController({
    keyFor: async () => "fixture:profile:tab",
    backend: { configure: async () => false, reset: async () => false },
    command: async (_context, _tabId, method, params) => { calls.push({ method, params }); return {}; },
  });
  await controller.apply(first, 7, { headers: { "X-Example": "test" } });
  assert.deepEqual(calls.map(call => call.method), ["Network.enable", "Network.setExtraHTTPHeaders"]);
});
