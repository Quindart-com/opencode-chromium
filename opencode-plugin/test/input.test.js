import assert from "node:assert/strict";
import { test } from "node:test";
import { keyDispatchEvents, parseKeyPress } from "../src/plugin.js";

test("parses Control+A as a select-all chord", () => {
  const parsed = parseKeyPress("Control+A");
  const events = keyDispatchEvents(parsed);

  assert.equal(parsed.selectAll, true);
  assert.deepEqual(parsed.modifiers, ["Control"]);
  assert.equal(parsed.primary.code, "KeyA");
  assert.equal(events[0].key, "Control");
  assert.equal(events[1].commands[0], "selectAll");
  assert.equal(events[1].modifiers, 2);
  assert.equal(Object.hasOwn(events[0], "bit"), false);
});

test("parses Shift+Tab with modifier key events", () => {
  const parsed = parseKeyPress("Shift+Tab");
  const events = keyDispatchEvents(parsed);

  assert.equal(parsed.selectAll, false);
  assert.deepEqual(parsed.modifiers, ["Shift"]);
  assert.equal(parsed.primary.code, "Tab");
  assert.equal(events[0].key, "Shift");
  assert.equal(events[1].key, "Tab");
  assert.equal(events[1].modifiers, 8);
});

test("rejects unsupported multi-character keys", () => {
  assert.throws(() => parseKeyPress("Control+DefinitelyNotAKey"), /Unsupported key/);
});
