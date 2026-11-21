import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ArtifactStore } from "../../src/core/artifacts.ts";
import { AgentBrowserRuntime } from "../../src/core/runtime.ts";
import { settleBrowserStep } from "../../src/core/settling.ts";
import { classifyTabTransition, originOf, snapshotTabs } from "../../src/core/tab-transition.ts";

const tab = (id, url) => ({ id, url });

test("transitions are classified by origin only", () => {
  const before = [tab(1, "https://www.liepin.com/job?secret=1")];
  assert.deepEqual(classifyTabTransition("click", 1, before, [tab(1, "https://www.liepin.com/job?secret=1#x")]).transition, { kind: "none" });
  const blank = classifyTabTransition("click", 1, before, [tab(1, "about:blank")]);
  assert.deepEqual(blank.transition, { kind: "blank", fromOrigin: "https://www.liepin.com", toOrigin: "about:blank" });
  assert.equal(blank.suspected, true);
  assert.equal(blank.hostname, "www.liepin.com");
  const closed = classifyTabTransition("click", 1, before, []);
  assert.deepEqual(closed.transition, { kind: "closed", fromOrigin: "https://www.liepin.com", toOrigin: null });
  assert.equal(closed.suspected, true);
  const opened = classifyTabTransition("click", 1, before, [...before, tab(2, "https://other.test/popup?token=1")]);
  assert.deepEqual(opened.transition, { kind: "opened", fromOrigin: "https://www.liepin.com", toOrigin: "https://other.test" });
  assert.equal(opened.suspected, false);
  assert.equal(JSON.stringify([blank, closed, opened]).includes("secret"), false);
});

test("same-site navigation is normal, cross-site navigation after typing is suspicious", () => {
  const before = [tab(1, "https://a.example.com/x")];
  assert.equal(classifyTabTransition("click", 1, before, [tab(1, "https://a.example.com/y")]).transition.kind, "navigated");
  assert.equal(classifyTabTransition("click", 1, before, [tab(1, "https://a.example.com/y")]).suspected, false);
  assert.equal(classifyTabTransition("click", 1, before, [tab(1, "https://elsewhere.test/")]).suspected, false, "a link click may leave the site");
  assert.equal(classifyTabTransition("type", 1, before, [tab(1, "https://elsewhere.test/")]).suspected, true);
  assert.equal(classifyTabTransition("click", 1, null, [tab(1, "about:blank")]), null);
  assert.equal(originOf("chrome://newtab/"), "chrome:");
  assert.equal(snapshotTabs({ tabs: [{ id: 3, url: "https://a.test" }, { tabId: 4 }, {}] }).length, 2);
});

function runtimeWith(tabsAfter) {
  const runtime = new AgentBrowserRuntime({
    artifactStore: new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tab-transition-test-")) }),
    hostRequest: async method => method === "semantic.status" ? { settings: {} } : method === "memory.captureState" ? { enabled: false } : {},
  });
  let listing = 0;
  runtime.selectProfile = async session => { session.profileId = "p"; return { profileId: "p" }; };
  runtime.ensureTab = async session => { session.activeTabId = 7; return 7; };
  runtime.executeStep = async () => ({ clicked: true, inputRoute: "dom" });
  runtime.settleStep = async () => ({ condition: "dom-quiet", settled: true });
  runtime.invoke = async name => {
    if (name === "browser_list_tabs") return { tabs: listing++ === 0 ? [tab(7, "https://guarded.test/page?q=1")] : tabsAfter };
    return {};
  };
  return { runtime };
}

test("a blanked tab yields a non-fatal PAGE_PROTECTION_SUSPECTED warning and guards the host", async () => {
  const { runtime } = runtimeWith([tab(7, "about:blank")]);
  try {
    const result = await runtime.run({ sessionId: "guard", memoryMode: "off", returnMode: "all", steps: [{ action: "click", target: { selector: "#edit" } }] });
    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.results[0].tabTransition, { kind: "blank", fromOrigin: "https://guarded.test", toOrigin: "about:blank" });
    assert.equal(result.results[0].warnings[0].code, "PAGE_PROTECTION_SUSPECTED");
    assert.equal(result.results[0].warnings[0].uncertain, true);
    assert.match(result.results[0].warnings[0].message, /Do not retry/);
    assert.equal(result.warnings[0].code, "PAGE_PROTECTION_SUSPECTED");
    assert.deepEqual([...runtime.getSession("guard").guardedHosts], ["guarded.test"]);
    assert.equal(JSON.stringify(result).includes("q=1"), false, "full URLs never leave the runtime");
  } finally { runtime.close(); }
});

test("a vanished tab is reported as closed, and an unchanged tab as none without a warning", async () => {
  const closed = runtimeWith([]);
  try {
    const result = await closed.runtime.run({ sessionId: "closed", memoryMode: "off", returnMode: "all", steps: [{ action: "doubleClick", target: { x: 5, y: 5 } }] });
    assert.equal(result.results[0].tabTransition.kind, "closed");
    assert.equal(result.results[0].warnings[0].code, "PAGE_PROTECTION_SUSPECTED");
  } finally { closed.runtime.close(); }
  const quiet = runtimeWith([tab(7, "https://guarded.test/page?q=1")]);
  try {
    const result = await quiet.runtime.run({ sessionId: "quiet", memoryMode: "off", returnMode: "all", steps: [{ action: "click", target: { selector: "#edit" } }] });
    assert.deepEqual(result.results[0].tabTransition, { kind: "none" });
    assert.equal(result.results[0].warnings, undefined);
    assert.equal(result.warnings, undefined);
    assert.equal(quiet.runtime.getSession("quiet").guardedHosts.size, 0);
  } finally { quiet.runtime.close(); }
});

test("runs record the input mode and cursor preference on the session", async () => {
  const { runtime } = runtimeWith([tab(7, "https://guarded.test/page?q=1")]);
  try {
    await runtime.run({ sessionId: "prefs", memoryMode: "off", inputMode: "pointer", cursor: false, steps: [{ action: "click", inputMode: "dom", target: { selector: "#x" } }] });
    const session = runtime.getSession("prefs");
    assert.equal(session.inputMode, "pointer");
    assert.equal(session.cursor, false);
  } finally { runtime.close(); }
});

test("guarded hosts and the input mode reach operation contexts", async () => {
  const runtime = new AgentBrowserRuntime({
    artifactStore: new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tab-transition-ctx-")) }),
    operationFactory: async () => ({ tool: { browser_probe: { args: {}, execute: async (_input, context) => JSON.stringify({ inputMode: context.inputMode, cursor: context.cursor, guarded: [...(context.guardedHosts ?? [])] }) } } }),
  });
  try {
    const session = runtime.getSession("ctx");
    session.inputMode = "pointer"; session.cursor = false; session.guardedHosts.add("a.test");
    assert.deepEqual(await runtime.invoke("browser_probe", {}, "ctx"), { inputMode: "pointer", cursor: false, guarded: ["a.test"] });
    assert.deepEqual(await runtime.operationScope.run({ inputMode: "dom" }, () => runtime.invoke("browser_probe", {}, "ctx")), { inputMode: "dom", cursor: false, guarded: ["a.test"] });
  } finally { runtime.close(); }
});

test("dom-quiet settling polls the mutation age instead of snapshotting the page", async () => {
  const calls = [];
  let age = 0;
  const runtime = {
    operationScope: { run: (_scope, task) => task() },
    resolveTarget: async () => ({}),
    invoke: async name => {
      calls.push(name);
      if (name === "browser_dom_quiet") { age += 300; return { documentId: "d", revision: 1, lastMutationAgeMs: age }; }
      throw new Error("a full snapshot must not be needed");
    },
  };
  const result = await settleBrowserStep(runtime, { action: "click" }, 7, new Map(), { sessionId: "s" });
  assert.deepEqual(result, { condition: "dom-quiet", settled: true });
  assert.equal(calls.every(name => name === "browser_dom_quiet"), true);
  assert.ok(calls.length >= 5, "polled until the page was quiet for 500ms");
});

test("dom-quiet settling falls back to snapshots when the cheap probe is unavailable", async () => {
  const calls = [];
  const runtime = {
    operationScope: { run: (_scope, task) => task() },
    resolveTarget: async () => ({}),
    invoke: async name => {
      calls.push(name);
      if (name === "browser_dom_quiet") throw new Error("Legacy operation is unavailable: browser_dom_quiet");
      return { nodes: [], observation: { lastMutationAgeMs: 900 } };
    },
  };
  const result = await settleBrowserStep(runtime, { action: "click" }, 7, new Map(), { sessionId: "s" });
  assert.equal(result.settled, true);
  assert.equal(calls.filter(name => name === "browser_dom_quiet").length, 1, "the missing probe is only tried once");
  assert.ok(calls.includes("browser_dom_snapshot"));
});
