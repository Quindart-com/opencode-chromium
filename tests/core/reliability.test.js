import assert from "node:assert/strict";
import test from "node:test";
import { AgentBrowserRuntime } from "../../src/core/runtime.js";
import { targetSchema } from "../../src/core/registry.js";

function fixture(t, steps) {
  const runtime = new AgentBrowserRuntime({
    artifactStore: { close() {} },
    operationFactory: async () => ({ tool: {} }),
    hostRequest: async (method) => {
      if (method === "memory.stats" || method === "memory.captureState") return { enabled: true };
      if (method === "memory.search") return { results: [{ kind: "chain_v2", id: 7, confidence: 0.95, steps }] };
      return {};
    },
  });
  t.after(() => runtime.close());
  runtime.selectProfile = async (session) => { session.profileId = "fixture-profile"; };
  runtime.ensureTab = async (session) => { session.activeTabId = 42; return 42; };
  runtime.invoke = async () => ({});
  runtime.settleStep = async () => null;
  return runtime;
}

test("a disconnect after dispatch cannot replay the mutation again", async (t) => {
  const runtime = fixture(t, [{ action: "click", target_label: "Open menu", hostname: "fixture.test" }]);
  runtime.memoryHostname = async () => "fixture.test";
  let dispatches = 0;
  runtime.executeStep = async () => {
    dispatches++;
    if (dispatches === 1) throw new Error("Browser host connection closed");
    return { done: true };
  };
  const result = await runtime.run({ sessionId: "fixture", memoryMode: "auto", memoryIntent: "open menu", steps: [{ action: "click", target: { query: "Open menu" } }] });
  assert.equal(dispatches, 1);
  assert.equal(result.ok, false);
});

test("replay preserves the requested key and action options", async (t) => {
  const runtime = fixture(t, [{ action: "press", hostname: "fixture.test" }]);
  runtime.memoryHostname = async () => "fixture.test";
  let executed;
  runtime.executeStep = async (step) => { executed = step; return {}; };
  await runtime.tryMemoryReplay({ memoryIntent: "dismiss", steps: [{ action: "press", key: "Escape", timeoutMs: 900 }] }, runtime.getSession("fixture"), 42);
  assert.equal(executed.key, "Escape");
  assert.equal(executed.timeoutMs, 900);
});

test("hostname attribution follows the live tab", async (t) => {
  const runtime = fixture(t, []);
  let url = "https://first.test/";
  runtime.invoke = async () => ({ url });
  const session = runtime.getSession("fixture");
  assert.equal(await runtime.memoryHostname({ action: "click" }, 42, session), "first.test");
  url = "https://second.test/";
  assert.equal(await runtime.memoryHostname({ action: "click" }, 99, session), "second.test");
});

test("target role survives public schema validation", () => {
  assert.equal(targetSchema.parse({ query: "Open", role: "button" }).role, "button");
});
