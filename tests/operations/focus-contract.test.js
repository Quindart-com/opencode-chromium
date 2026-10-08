import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());
const operationsSource = fs.readFileSync(path.join(root, "src", "browser", "operations", "index.js"), "utf8");

test("ordinary pointer operations preserve Chromium page-local input through the backend", () => {
  assert.doesNotMatch(operationsSource, /async function dispatchMouse\(/);
  assert.match(operationsSource, /pageBackend\.click\(context, tabId, trusted => clickAtPointExpression\(x, y, \{ button, trusted \}\)/);
  assert.match(operationsSource, /clickAtPointExpression\(args\.x, args\.y, \{ button: args\.button, clickCount: 2, trusted \}\)/);
  assert.match(operationsSource, /domNodeClickExpression\(args\.nodeId, \{ trusted \}\)/);
  assert.match(operationsSource, /selectorClickExpression\(args\.selector, \{ trusted \}\)/);
  assert.match(operationsSource, /hoverAtPointExpression/);
  assert.match(operationsSource, /scrollFallbackExpression/);
});

test("native CDP mouse input is retained only for the trusted drag gesture path", () => {
  const dragSource = operationsSource.slice(operationsSource.indexOf("browser_drag:"));
  assert.match(dragSource, /inputGesture\(context, args\.tabId, steps/);
  assert.match(operationsSource, /method: "Input\.dispatchMouseEvent"/);
});
