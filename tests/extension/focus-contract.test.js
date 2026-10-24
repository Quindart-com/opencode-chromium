import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { finalizeOwnedTabs } from "../../extension-src/entrypoints/background/finalize-session.ts";

const root = path.resolve(process.cwd());
const extensionSource = fs.readFileSync(
  path.join(root, "extension-src", "entrypoints", "background", "runtime.ts"),
  "utf8",
).replace(/\{\s+\}/g, "{}").replace(/^( +)/gm, spaces => " ".repeat(Math.ceil(spaces.length / 2)));
const operationsSource = fs.readFileSync(path.join(root, "src", "browser", "operations", "index.ts"), "utf8");

test("the extension only activates tabs through the explicit focus policy", () => {
  assert.match(extensionSource, /resolveTabActivation\(params\)/);
  assert.match(extensionSource, /options\.active === true/);
  assert.match(extensionSource, /chrome\.tabs\.update\(tabId, \{ active: true \}/);
});

test("window focus is gated behind an explicit foreground request", () => {
  assert.match(extensionSource, /if \(options\.foreground &&\s*Number\.isInteger\(tab\.windowId\)\)/);
  assert.match(extensionSource, /chrome\.windows\.update\(tab\.windowId, \{ focused:\s*true \}/);
});

test("new tabs and windows are created without stealing focus", () => {
  assert.match(extensionSource, /chrome\.tabs\.create\(\{ active: false, url:\s*"about:blank", windowId \}/);
  assert.match(extensionSource, /chrome\.windows\.create\(\{ focused: false, type: "normal", url:\s*"about:blank" \}/);
});

test("tab and window activation appear only inside the focus policy", () => {
  const tabActivations = extensionSource.match(/active: true/g) ?? [];
  const windowFocus = extensionSource.match(/focused: true/g) ?? [];
  assert.equal(tabActivations.length, 1);
  assert.equal(windowFocus.length, 1);
});

test("background operation activation requests are always passive", () => {
  const call = /extensionRequest\(context, "activateTab", \{ tabId, foreground: false, active: false \}\)/;
  assert.match(operationsSource, call);
  assert.doesNotMatch(operationsSource, /extensionRequest\(context, "activateTab"[^\n]*foreground: true/);
});

test("finalized deliverables use the dedicated OpenCode group", () => {
  assert.match(extensionSource, /const DELIVERABLE_GROUP_TITLE = "OpenCode Deliverables";/);
  assert.match(extensionSource, /chrome\.tabGroups\.query\(\{ windowId \}\)/);
  assert.match(extensionSource, /group\.title === DELIVERABLE_GROUP_TITLE && group\.windowId === windowId/);
  assert.match(extensionSource, /deliver: ensureDeliverableGroup/);
});

test("kept tabs default to handoff", () => {
  assert.match(extensionSource, /typeof item === "number" \? "handoff" : item\.status \?\? "handoff"/);
  assert.match(operationsSource, /status: tool\.schema\.enum\(\["handoff", "deliverable"\]\)\.default\("handoff"\)/);
});

test("handoff keeps ownership and deliverables are grouped before release", async () => {
  const session = { tabIds: new Set([1, 2]), tabOrigins: new Map([[1, "agent"], [2, "agent"]]) };
  const calls = [];
  const result = await finalizeOwnedTabs(session, new Map([[1, "handoff"], [2, "deliverable"]]), {
    dialog: () => null, detach: async () => {}, hide: async () => {}, ungroup: async () => {}, close: async () => assert.fail("kept tabs cannot close"),
    deliver: async id => calls.push(["deliver", id]), untrack: async id => { calls.push(["untrack", id]); session.tabIds.delete(id); },
  });
  assert.equal(result.partial, false);
  assert.deepEqual(calls, [["deliver", 2], ["untrack", 2]]);
  assert.deepEqual([...session.tabIds], [1]);
});

test("a failed close retains ownership and reports partial cleanup", async () => {
  const session = { tabIds: new Set([1]), tabOrigins: new Map([[1, "agent"]]) };
  const result = await finalizeOwnedTabs(session, new Map(), { dialog: () => null, detach: async () => {}, hide: async () => {}, deliver: async () => {}, ungroup: async () => {},
    close: async () => { throw new Error("blocked close"); }, untrack: async () => assert.fail("must retain ownership"),
  });
  assert.equal(result.partial, true);
  assert.equal(result.tabs[0].status, "blocked");
});
