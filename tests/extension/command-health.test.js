import assert from "node:assert/strict";
import { test } from "bun:test";
import { CommandHealth } from "../../extension-src/entrypoints/background/command-health.ts";
import { finalizeOwnedTabs } from "../../extension-src/entrypoints/background/finalize-session.ts";
import { beforeDeadline } from "../../src/shared/deadline.ts";
import { partialDispatchError } from "../../src/shared/execution-state.ts";
import { createDebuggerAttacher } from "../../extension-src/entrypoints/background/debugger-attach.ts";

test("expired queued work cannot execute; a stuck tab does not block another tab", async () => {
  const health = new CommandHealth();
  let release, executed = false;
  const first = health.run(1, () => new Promise(resolve => { release = resolve; }), Date.now() + 1000);
  await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(health.run(1, async () => { executed = true; }, Date.now() + 20), error => error.executionState === "not_started" && !error.uncertain);
  assert.equal(await health.run(2, async () => "ready"), "ready");
  assert.equal(executed, false);
  release(); await first;
});

test("a timed-out mutation stays uncertain and dialog health survives history clearing", async () => {
  const health = new CommandHealth();
  health.event(1, "Page.javascriptDialogOpening", { type: "prompt" });
  await assert.rejects(health.run(1, () => new Promise(() => {}), Date.now() + 10, "Runtime.evaluate"), error => error.uncertain && error.details.dialogType === "prompt");
  assert.equal(health.snapshot([1])[0].dialog.type, "prompt");
  health.event(1, "Page.javascriptDialogClosed", {});
  assert.equal(health.snapshot([1])[0].dialog, null);
});

test("expired operations do not start and late completion is explicitly cleaned up", async () => {
  let ran = false, late = false;
  await assert.rejects(beforeDeadline(() => { ran = true; }, Date.now() - 1, { phase: "attach" }));
  assert.equal(ran, false);
  await assert.rejects(beforeDeadline(() => new Promise(resolve => setTimeout(resolve, 30)), Date.now() + 5, { phase: "attach" }, () => { late = true; }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(late, true);
});

test("finalize preserves a dialog-blocked tab and independently releases safe user tabs", async () => {
  const session = { tabIds: new Set([1, 2, 3]), tabOrigins: new Map([[1, "agent"], [2, "user"], [3, "agent"]]) };
  const reviewed = [], untracked = [];
  const result = await finalizeOwnedTabs(session, new Map([[3, "handoff"]]), {
    dialog: id => id === 1 ? { type: "beforeunload" } : null,
    detach: async () => {}, hide: async () => {}, deliver: async ids => { reviewed.push(...ids); },
    untrack: async id => { untracked.push(id); session.tabIds.delete(id); },
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.tabs.map(tab => tab.status), ["blocked", "released", "kept"]);
  assert.deepEqual(reviewed, [2]);
  assert.deepEqual(untracked, [2]);
  assert.deepEqual([...session.tabIds], [1, 3]);
});

test("a late debugger attachment is detached and cannot restore expired ownership", async () => {
  const health = new CommandHealth(), attachedTabs = new Map();
  let complete, detached = 0;
  const attach = createDebuggerAttacher({ withTabLock: (...args) => health.run(...args), attachedTabs,
    getTab: async () => ({ url: "https://fixture.test" }), isBrowserInternalUrl: () => false, DEBUGGER_VERSION: "1.3", DEFAULT_CDP_TIMEOUT_MS: 1000,
    errorMessage: error => error.message, chrome: { debugger: { attach: () => new Promise(resolve => { complete = resolve; }), detach: async () => { detached++; } } },
    sendCdpCommand: async () => {}, generation: id => health.generation(id), trackPending: (id, task) => health.track(id, task),
  });
  await assert.rejects(attach(1, "session", Date.now() + 45), { code: "TIMEOUT", executionState: "not_started" });
  assert.equal(health.idle(), false);
  await assert.rejects(health.run(1, async () => "must not dispatch"), { code: "TAB_UNHEALTHY" });
  assert.equal(await health.run(2, async () => "healthy"), "healthy");
  complete();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(detached, 1);
  assert.equal(attachedTabs.size, 0);
  assert.equal(health.idle(), true);
});

test("a later gesture rejection preserves uncertainty after an earlier command completed", async () => {
  const health = new CommandHealth();
  const rejected = Object.assign(new Error("Frame disappeared"), { code: "FRAME_NOT_FOUND", executionState: "not_started", uncertain: false });
  await assert.rejects(health.run(1, async () => { throw partialDispatchError(rejected, 1); }), { code: "FRAME_NOT_FOUND", executionState: "unknown", uncertain: true, retryable: false });
  assert.equal(partialDispatchError(rejected, 0), rejected);
});
