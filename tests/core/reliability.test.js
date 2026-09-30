import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserRuntime } from "../../src/core/runtime.js";
import { targetSchema } from "../../src/core/registry.js";
import { MemoryStore } from "../../native-host/src/memory/store.js";

function fixture(t, steps) {
  const runtime = new AgentBrowserRuntime({
    artifactStore: { close() {} },
    operationFactory: async () => ({ tool: {} }),
    hostRequest: async (method) => {
      if (method === "memory.stats" || method === "memory.captureState") return { enabled: true };
      if (method === "memory.search") return { results: [{ kind: "chain_v2", id: 7, similarity: 0.95, confidence: 0.95, failed_count: 0, steps }] };
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

test("replay completes the turn and honors post-observation", async (t) => {
  const runtime = fixture(t, [{ action: "press", hostname: "fixture.test" }]);
  runtime.memoryHostname = async () => "fixture.test";
  runtime.executeStep = async () => ({ done: true });
  const invoked = [];
  runtime.invoke = async (method) => { invoked.push(method); return {}; };
  runtime.observeValue = async () => ({ title: "After replay" });
  const result = await runtime.run({ sessionId: "fixture", memoryMode: "auto", memoryIntent: "dismiss", steps: [{ action: "press", key: "Escape" }], postObserve: { mode: "inspect" } });
  assert.equal(result.ok, true);
  assert.equal(result.observation.title, "After replay");
  assert.equal(invoked.filter((method) => method === "browser_turn_end").length, 1);
});

// The end-to-end shape of the reported bug: a workflow that has already been
// recorded must replay on a plain repeat, with no memoryMode and no
// memoryIntent, because nothing else ever told the agent to pass them.
test("a recorded workflow replays on a plain repeat through a real store", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-replay-e2e-"));
  const store = new MemoryStore({ root });
  store.enable();
  const runtime = new AgentBrowserRuntime({
    artifactStore: { close() {} },
    operationFactory: async () => ({ tool: {} }),
    hostRequest: async (method, params) => {
      if (method === "semantic.status") return { settings: {} };
      if (method === "memory.captureState") return store.captureState();
      if (method === "memory.recipe") return store.findRecipe(params);
      if (method === "memory.search") return { results: [] };
      if (method === "memory.usageEvent") return store.usageEvent(params);
      if (method === "memory.recordStep") return store.recordStep(params);
      if (method === "memory.finalizeChain") return store.finalizeChain(params);
      return {};
    },
  });
  t.after(() => {
    runtime.close();
    store.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL. */ }
  });
  runtime.selectProfile = async (session) => { session.profileId = "fixture-profile"; };
  runtime.ensureTab = async (session) => { session.activeTabId = 42; return 42; };
  runtime.settleStep = async () => null;
  runtime.invoke = async (method) => method === "browser_get_tab" ? { id: 42, url: "https://fixture.test/page" } : {};
  runtime.executeStep = async () => ({ done: true });

  const steps = [
    { action: "click", target: { query: "Open menu" } },
    { action: "click", target: { query: "Billing" } },
  ];
  const first = await runtime.run({ sessionId: "fixture-repeat", steps });
  assert.equal(first.status, "completed");
  assert.equal(first.memory, undefined, "the first run records rather than replays");

  const second = await runtime.run({ sessionId: "fixture-repeat", steps });
  assert.equal(second.status, "memory_replay");
  assert.deepEqual(second.memory, { used: true, stepsReused: 2, fallback: false });

  const usage = store.status().usage;
  assert.equal(usage.replay_attempts, 1);
  assert.equal(usage.replay_successes, 1);
  assert.equal(usage.replay_success_rate, 100);
  assert.equal(usage.replay_rejections, 0);

  const third = await runtime.run({ sessionId: "fixture-repeat-off", memoryMode: "off", steps });
  assert.equal(third.status, "completed");
  assert.equal(store.status().usage.replay_attempts, 1, "memoryMode off must not add attempts");
});
