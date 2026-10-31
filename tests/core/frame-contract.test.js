import assert from "node:assert/strict";
import { test as bunTest } from "bun:test";
import { AgentBrowserRuntime } from "../../src/core/runtime.ts";
import { targetSchema } from "../../src/core/registry.ts";

const test = (name, run) => bunTest(name, async () => {
  const cleanup = [];
  try { return await run({ after: callback => cleanup.push(callback) }); }
  finally { for (const callback of cleanup.reverse()) await callback(); }
});

function fixture(t) {
  const runtime = new AgentBrowserRuntime({ artifactStore: { close() {} }, operationFactory: async () => ({ tool: {} }) });
  t.after(() => runtime.close());
  return runtime;
}

test("frame identity survives canonical validation and fromStep targeted keyboard input", async t => {
  const runtime = fixture(t);
  assert.equal(targetSchema.parse({ frameId: "child" }).frameId, "child");
  const calls = [];
  runtime.invoke = async (name, args) => { calls.push({ name, args, frame: runtime.operationScope.getStore()?.frameId }); return {}; };
  const prior = new Map([["choice", { results: [{ node_id: "node:child:document:1", frameId: "child", selector: "#choose" }] }]]);
  await runtime.executeStep({ action: "press", key: "Enter", target: { fromStep: "choice" } }, 1, prior, runtime.getSession("frame"));
  assert.equal(calls[0].name, "browser_keypress");
  assert.equal(calls[0].args.nodeId, "node:child:document:1");
  assert.equal(calls[0].args.frameId, "child");
  assert.equal(calls[0].frame, "child");
});

test("concurrent frame observations keep independent contexts", async t => {
  const runtime = fixture(t), frames = [];
  runtime.invoke = async () => { await new Promise(resolve => setTimeout(resolve, 5)); frames.push(runtime.operationScope.getStore()?.frameId); return { text: "ready" }; };
  await Promise.all(["first", "second"].map(frameId => runtime.observeValue({ mode: "extract", target: { frameId, selector: "#status" } }, 1, runtime.getSession("frame"))));
  assert.deepEqual(frames.sort(), ["first", "second"]);
});

test("unsettled dispatch is excluded from successful memory records", async t => {
  const runtime = fixture(t); let recorded;
  runtime.executeStep = async () => ({ clicked: true });
  runtime.settleStep = async () => ({ settled: false, timedOut: true });
  runtime.recordMemoryStep = async value => { recorded = value; };
  const outcome = await runtime.executeStepWithPolicy({ step: { action: "click", target: { selector: "#open" } }, index: 0, tabId: 1, prior: new Map(), session: runtime.getSession("frame"), chainId: "chain", memoryEnabled: true });
  assert.equal(outcome.executionState, "completed");
  assert.equal(recorded.success, false);
  assert.equal(recorded.errorCode, "SETTLE_UNVERIFIED");
});

test("partial finalization keeps the runtime session recoverable", async t => {
  const runtime = fixture(t);
  runtime.selectProfile = async () => ({ profileId: "fixture" });
  runtime.invoke = async () => ({ partial: true, profiles: { fixture: { tabs: [{ tabId: 1, status: "blocked" }] } } });
  runtime.getSession("recoverable");
  const result = await runtime.finalize({ sessionId: "recoverable", keepEnvironment: true });
  assert.equal(result.status, "partial");
  assert.equal(runtime.sessions.has("recoverable"), true);
});

test("a failed environment reset cannot prevent cleanup of another tab", async t => {
  const runtime = fixture(t), reset = [];
  const session = runtime.getSession("configured"); session.profileId = "fixture";
  session.configuredTabs.set("fixture:1", { profileId: "fixture", tabId: 1 });
  session.configuredTabs.set("fixture:2", { profileId: "fixture", tabId: 2 });
  runtime.selectProfile = async () => ({ profileId: "fixture" });
  runtime.invoke = async (name, args) => {
    if (name === "browser_list_tabs") return { tabs: [{ id: 1 }, { id: 2 }] };
    if (name === "browser_configure") { reset.push(args.tabId); if (args.tabId === 1) throw Error("dialog blocked"); return {}; }
    assert.equal(name, "browser_finalize");
    assert.deepEqual(args.blockedTabs, [{ tabId: 1, profileId: "fixture", reason: "dialog blocked" }]);
    return { partial: true };
  };
  const result = await runtime.finalize({ sessionId: "configured" });
  assert.equal(result.status, "partial");
  assert.deepEqual(reset, [1, 2]);
  assert.equal(session.configuredTabs.has("fixture:1"), true);
  assert.equal(session.configuredTabs.has("fixture:2"), false);
});

test("contains settling waits for a delayed target to appear", async t => {
  const runtime = fixture(t); let reads = 0;
  runtime.invoke = async () => {
    if (++reads < 3) throw Object.assign(new Error("Not yet rendered"), { code: "TARGET_NOT_FOUND" });
    return { text: "Saved" };
  };
  const result = await runtime.settleStep({ action: "click", settle: { condition: "contains", target: { selector: "#status" }, value: "Saved", timeoutMs: 1000 } }, 1, new Map(), runtime.getSession("delayed"));
  assert.equal(result.settled, true);
  assert.equal(reads, 3);
});

test("changing visible values cannot settle using an old mutation timestamp", async t => {
  const runtime = fixture(t); let value = 0;
  runtime.invoke = async () => ({ observation: { lastMutationAgeMs: 5000 }, nodes: [{ text: String(value++) }] });
  const result = await runtime.settleStep({ action: "click", settle: { condition: "dom-quiet", timeoutMs: 650 } }, 1, new Map(), runtime.getSession("changing"));
  assert.equal(result.settled, false);
});

test("partially filled forms remain uncertain and cannot be automatically retried", async t => {
  const runtime = fixture(t); let calls = 0;
  runtime.invoke = async () => {
    if (++calls === 1) return { filled: true };
    throw Object.assign(new Error("Second field was removed"), { code: "TARGET_NOT_FOUND", executionState: "not_started", uncertain: false });
  };
  const outcome = await runtime.executeStepWithPolicy({ step: { action: "fillForm", fields: { "#first": "fixture", "#second": "fixture" } }, index: 0, tabId: 1, prior: new Map(), session: runtime.getSession("partial-form"), chainId: null, memoryEnabled: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.executionState, "unknown");
  assert.equal(outcome.error.uncertain, true);
  assert.equal(outcome.error.retryable, false);
  assert.equal(outcome.error.details.completedCommands, 1);
  assert.equal(calls, 2);
});
