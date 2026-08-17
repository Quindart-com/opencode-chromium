import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());
const extensionSource = fs.readFileSync(path.join(root, "extension", "src", "background.js"), "utf8");
const operationsSource = fs.readFileSync(path.join(root, "src", "browser", "operations", "index.js"), "utf8");

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
  assert.match(extensionSource, /chrome\.tabGroups\.query\(\{ windowId \}, done\)/);
  assert.match(extensionSource, /group\.title === DELIVERABLE_GROUP_TITLE && group\.windowId === windowId/);
  assert.match(extensionSource, /if \(status === "deliverable"\) \{\s*await ensureDeliverableGroup\(tabId\)/);
});
