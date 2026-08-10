import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTabActivation } from "../../extension/src/focus-policy.js";

test("background operations never activate the tab or focus the window", () => {
  assert.deepEqual(resolveTabActivation({}), { active: false, foreground: false });
  assert.deepEqual(resolveTabActivation({ active: false }), { active: false, foreground: false });
  assert.deepEqual(resolveTabActivation({ foreground: false }), { active: false, foreground: false });
  assert.deepEqual(resolveTabActivation({ active: false, foreground: false }), { active: false, foreground: false });
});

test("activation is only granted when a caller explicitly requests it", () => {
  assert.deepEqual(resolveTabActivation({ active: true }), { active: true, foreground: false });
  assert.deepEqual(resolveTabActivation({ foreground: true }), { active: true, foreground: true });
  assert.deepEqual(resolveTabActivation({ active: true, foreground: true }), { active: true, foreground: true });
});