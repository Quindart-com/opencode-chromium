import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorActionForStep, cursorActionForTool, cursorPoint, isCursorAction } from "../../src/browser/cursor.js";

test("every interactive tool maps to a cursor animation", () => {
  const expected = {
    browser_page_search: "observe",
    browser_dom_snapshot: "observe",
    browser_click: "click",
    browser_dom_click: "click",
    browser_locator_click: "click",
    browser_drag: "drag",
    browser_scroll: "scroll",
    browser_type: "text",
    browser_locator_fill: "text",
    browser_keypress: "key",
    browser_move: "navigate",
    browser_navigate: "navigate",
    browser_new_tab: "navigate",
    browser_finalize: "transfer",
    browser_trace_record: "record",
    browser_configure: "system",
  };
  for (const [name, action] of Object.entries(expected)) assert.equal(cursorActionForTool(name), action, name);
  assert.equal(cursorActionForTool("browser_unknown_tool"), null);
  assert.equal(cursorActionForTool(undefined), null);
});

test("run steps map to the same animation vocabulary", () => {
  assert.equal(cursorActionForStep("click"), "click");
  assert.equal(cursorActionForStep("find"), "observe");
  assert.equal(cursorActionForStep("fill"), "text");
  assert.equal(cursorActionForStep("drag"), "drag");
  assert.equal(cursorActionForStep("upload"), "transfer");
  assert.equal(cursorActionForStep("capability"), "system");
  assert.equal(cursorActionForStep("nonsense"), null);
});

test("only finite numbers become a cursor point", () => {
  assert.deepEqual(cursorPoint({ x: 4, y: 9 }), { x: 4, y: 9 });
  assert.deepEqual(cursorPoint({ x: 0, y: 0 }), { x: 0, y: 0 });
  assert.equal(cursorPoint({ x: "4", y: "9" }), null, "string coordinates are rejected rather than coerced");
  assert.equal(cursorPoint({ x: 4 }), null);
  assert.equal(cursorPoint({ x: Number.NaN, y: 1 }), null);
  assert.equal(cursorPoint(null), null);
});

test("blank actions are not treated as animations", () => {
  assert.equal(isCursorAction("click"), true);
  assert.equal(isCursorAction(""), false);
  assert.equal(isCursorAction(null), false);
});
