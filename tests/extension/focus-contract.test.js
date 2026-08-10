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

test("background operation activation requests are always passive", () => {
  const call = /extensionRequest\(context, "activateTab", \{ tabId, foreground: false, active: false \}\)/;
  assert.match(operationsSource, call);
});