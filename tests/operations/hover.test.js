import assert from "node:assert/strict";
import { test } from "node:test";
import { domNodeHoverTargetExpression, selectorHoverTargetExpression } from "../../src/browser/operations/index.js";

test("node hover expression resolves the strict node map and scrolls into view", () => {
  const source = domNodeHoverTargetExpression("node-1");
  assert.match(source, /hoverTarget\(nodeByIdStrict\("node-1"\)\)/);
  assert.match(source, /scrollIntoView/);
});

test("selector hover expression resolves the strict selector and returns the element center", () => {
  const source = selectorHoverTargetExpression("#settings");
  assert.match(source, /hoverTarget\(querySelectorStrict\("#settings"\)\)/);
  assert.match(source, /rect\.left \+ Math\.max\(1, rect\.width - 1\) \* 0\.5/);
});