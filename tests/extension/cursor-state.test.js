import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_SCRIPTS, cursorIdFromParams, cursorLabel, cursorState, gestureAction } from "../../extension-src/entrypoints/background/cursor-state.js";

test("the injected cursor scripts load the artwork before the renderer", () => {
  assert.deepEqual(CURSOR_SCRIPTS, ["content-scripts/cursor-theme.js", "content-scripts/cursor.js"]);
});

test("a cursor belongs to its session unless one is named explicitly", () => {
  assert.equal(cursorIdFromParams({ session_id: "abc" }), "abc");
  assert.equal(cursorIdFromParams({ sessionId: "abc" }), "abc");
  assert.equal(cursorIdFromParams({ cursorId: "named", sessionId: "abc" }), "named");
  assert.equal(cursorIdFromParams({}), "default");
  assert.equal(cursorIdFromParams({ session_id: "" }), "default");
});

test("gesture batches resolve to the semantic action the browser is asked to perform", () => {
  const mouse = (type, buttons = 0) => ({ method: "Input.dispatchMouseEvent", commandParams: { type, buttons } });
  assert.equal(gestureAction(mouse("mouseWheel")), "scroll");
  assert.equal(gestureAction(mouse("mousePressed", 1), false), "click");
  assert.equal(gestureAction(mouse("mouseMoved", 1), true), "drag");
  assert.equal(gestureAction(mouse("mouseReleased", 0), true), "click");
  assert.equal(gestureAction(mouse("mouseMoved", 0), false), null);
  assert.equal(gestureAction({ method: "Input.insertText" }), "text");
  assert.equal(gestureAction({ method: "Input.dispatchKeyEvent", commandParams: { text: "a" } }), "text");
  assert.equal(gestureAction({ method: "Input.dispatchKeyEvent", commandParams: {} }), "key");
  assert.equal(gestureAction({ method: "Runtime.evaluate" }), null);
  assert.equal(gestureAction(undefined), null);
});

test("the label is the session name when one exists and stays inside the pill", () => {
  assert.equal(cursorLabel({ name: "Research agent" }, "session-1"), "Research agent");
  assert.equal(cursorLabel({}, "session-1"), "session-1");
  assert.equal(cursorLabel({}, "default"), "opencode");
  assert.equal(cursorLabel({ name: "   " }, "default"), "opencode");
  const long = cursorLabel({}, "0123456789012345678901234567890123456789");
  assert.equal(long.length <= 28, true, `label is truncated, got ${long.length} characters`);
  assert.match(long, /…$/);
});

test("a cursor state carries position, sequence, label and action", () => {
  const state = cursorState({ cursorId: "s1", session: { name: "Builder" }, x: 10, y: 20, moveSequence: 3, action: "click" });
  assert.deepEqual(state, { x: 10, y: 20, visible: true, moveSequence: 3, cursorId: "s1", label: "Builder", action: "click" });
  const hidden = cursorState({ cursorId: "s1", session: {}, x: 1, y: 2, visible: false, moveSequence: 4, action: null });
  assert.equal(hidden.visible, false);
  assert.equal("action" in hidden, false, "an absent action never clears the animation with a null");
});
