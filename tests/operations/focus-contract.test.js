import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());
const operationsSource = fs.readFileSync(path.join(root, "src", "browser", "operations", "index.js"), "utf8");

test("ordinary pointer operations avoid the renderer-focusing CDP mouse helper", () => {
  assert.doesNotMatch(operationsSource, /async function dispatchMouse\(/);
  assert.match(operationsSource, /runtimeEvaluate\(context, tabId, clickAtPointExpression\(x, y, \{ button \}\)/);
  assert.match(operationsSource, /clickAtPointExpression\(args\.x, args\.y, \{ button: args\.button, clickCount: 2 \}\)/);
  assert.match(operationsSource, /domNodeClickExpression\(args\.nodeId\)/);
  assert.match(operationsSource, /selectorClickExpression\(args\.selector\)/);
  assert.match(operationsSource, /hoverAtPointExpression/);
  assert.match(operationsSource, /scrollFallbackExpression/);
});

test("native CDP mouse input is retained only for the trusted drag gesture path", () => {
  const dragSource = operationsSource.slice(operationsSource.indexOf("browser_drag:"));
  assert.match(dragSource, /inputGesture\(context, args\.tabId, steps/);
  assert.match(operationsSource, /method: "Input\.dispatchMouseEvent"/);
});
