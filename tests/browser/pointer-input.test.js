import assert from "node:assert/strict";
import { test } from "bun:test";
import { createPointerInput, pointerPath, selectInputRoute } from "../../src/browser/pointer-input.ts";

function fixedRandom() { let n = 0; return () => ((n++ * 37) % 100) / 100; }

function harness({ facts = { active: true, hostname: "site.test" }, cursor = true, point = { x: 300, y: 200, tagName: "button" } } = {}) {
  const gestures = [];
  const evaluated = [];
  const input = createPointerInput({
    runtimeEvaluate: async (_context, _tab, expression, options) => { evaluated.push({ expression, options }); return point; },
    inputGesture: async (_context, tabId, steps) => { gestures.push({ tabId, steps }); return {}; },
    mouseStep: (commandParams, cursorPoint, delayMs = 0) => ({ method: "Input.dispatchMouseEvent", commandParams, cursor: cursorPoint, delayMs }),
    tabFacts: async () => facts,
    cursorEnabled: async () => cursor,
    key: (context, tabId) => `${context.sessionId}:${tabId}`,
    random: fixedRandom(),
  });
  return { input, gestures, evaluated, context: { sessionId: "s" } };
}

test("the pointer path ends exactly on the target with human-scale timing", () => {
  const path = pointerPath({ x: 10, y: 10 }, { x: 400, y: 300 }, fixedRandom());
  assert.deepEqual({ x: path.at(-1).x, y: path.at(-1).y }, { x: 400, y: 300 });
  assert.ok(path.length >= 4 && path.length <= 14);
  const total = path.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(total >= 16 && total <= 14 * 12, `total delay ${total}`);
});

test("route selection: dom and frames stay in-page, pointer is forced, auto follows focus or guard", () => {
  assert.equal(selectInputRoute({ mode: "dom", guarded: true, active: true }), "dom");
  assert.equal(selectInputRoute({ mode: "pointer", guarded: false, active: false }), "pointer");
  assert.equal(selectInputRoute({ mode: "pointer", frame: true, guarded: true, active: true }), "dom");
  assert.equal(selectInputRoute({ mode: "auto", guarded: false, active: true }), "pointer");
  assert.equal(selectInputRoute({ guarded: false, active: false }), "dom");
  assert.equal(selectInputRoute({ guarded: true, active: false }), "pointer");
});

test("auto route uses the active tab, a guarded host, or falls back to dom for background tabs", async () => {
  const background = harness({ facts: { active: false, hostname: "site.test" } });
  assert.equal(await background.input.route(background.context, 1), "dom");
  assert.equal(await background.input.route({ ...background.context, guardedHosts: new Set(["site.test"]) }, 1), "pointer");
  assert.equal(await background.input.route({ ...background.context, guardedHosts: new Set(["other.test"]) }, 1), "dom");
  assert.equal(await background.input.route({ ...background.context, inputMode: "pointer" }, 1), "pointer");
  const active = harness();
  assert.equal(await active.input.route(active.context, 1), "pointer");
  assert.equal(await active.input.route({ ...active.context, inputMode: "dom" }, 1), "dom");
  assert.equal(await active.input.route({ ...active.context, frameId: "child" }, 1), "dom");
});

test("a pointer click resolves the point without clicking, moves, then presses and releases", async () => {
  const { input, gestures, evaluated, context } = harness();
  const point = await input.click(context, 1, trusted => `expression(${trusted})`, { button: "left" });
  assert.deepEqual({ x: point.x, y: point.y }, { x: 300, y: 200 });
  assert.equal(evaluated[0].expression, "expression(true)", "the resolver runs in trusted mode so it never calls element.click()");
  const types = gestures[0].steps.map(step => step.commandParams.type);
  assert.deepEqual(types.filter(type => type === "mouseMoved").length, types.length - 2);
  assert.deepEqual(types.slice(-2), ["mousePressed", "mouseReleased"]);
  assert.equal(types.indexOf("mousePressed"), types.length - 2, "all moves precede the press");
  const [press, release] = gestures[0].steps.slice(-2).map(step => step.commandParams);
  assert.deepEqual({ button: press.button, buttons: press.buttons, clickCount: press.clickCount, x: press.x, y: press.y }, { button: "left", buttons: 1, clickCount: 1, x: 300, y: 200 });
  assert.deepEqual({ buttons: release.buttons, clickCount: release.clickCount }, { buttons: 0, clickCount: 1 });
  assert.ok(gestures[0].steps.every(step => step.cursor), "the visible cursor follows the pointer");
  const total = gestures[0].steps.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(total >= 30 && total <= 300, `total delay ${total}`);
});

test("a double click sends two press/release pairs with click counts 1 and 2", async () => {
  const { input, gestures, context } = harness();
  await input.click(context, 1, () => "e", { button: "right", clickCount: 2 });
  const presses = gestures[0].steps.filter(step => ["mousePressed", "mouseReleased"].includes(step.commandParams.type));
  assert.deepEqual(presses.map(step => [step.commandParams.type, step.commandParams.clickCount, step.commandParams.button]), [
    ["mousePressed", 1, "right"], ["mouseReleased", 1, "right"], ["mousePressed", 2, "right"], ["mouseReleased", 2, "right"],
  ]);
  assert.equal(presses[0].commandParams.buttons, 2);
});

test("the pointer starts from the last known position and omits the overlay when disabled", async () => {
  const { input, gestures, context } = harness({ cursor: false });
  await input.click(context, 1, () => "e");
  assert.ok(gestures[0].steps.every(step => step.cursor === undefined));
  assert.deepEqual(input.lastPoint(context, 1), { x: 300, y: 200 });
  await input.hover(context, 1, { x: 320, y: 220 });
  const first = gestures[1].steps[0].commandParams;
  assert.ok(Math.hypot(first.x - 300, first.y - 200) < Math.hypot(320 - 300, 220 - 200) + 40, "the second path starts near the previous point");
  assert.equal(gestures[1].steps.every(step => step.commandParams.type === "mouseMoved"), true);
});

test("a skipped target is resolved but never clicked", async () => {
  const { input, gestures, context } = harness({ point: { x: 5, y: 5, tagName: "select" } });
  await input.click(context, 1, () => "e", { skip: point => point.tagName === "select" });
  assert.equal(gestures.length, 0);
});

test("a hidden tab is revealed before pointer input, and fails fast when it stays hidden", async () => {
  for (const revealWorks of [true, false]) {
    let hidden = true, revealed = 0;
    const gestures = [];
    const input = createPointerInput({
      runtimeEvaluate: async (_context, _tab, expression) => expression === "document.visibilityState" ? (hidden ? "hidden" : "visible") : { x: 10, y: 10 },
      inputGesture: async (_context, _tab, steps) => { gestures.push(steps); return {}; },
      mouseStep: (commandParams, cursor, delayMs = 0) => ({ method: "Input.dispatchMouseEvent", commandParams, cursor, delayMs }),
      tabFacts: async () => ({ active: false, hostname: "site.test" }),
      cursorEnabled: async () => false,
      key: () => "k",
      revealTab: async () => { revealed += 1; if (revealWorks) hidden = false; },
      sleep: async () => {},
      random: fixedRandom(),
    });
    const click = input.click({ sessionId: "s" }, 1, () => "point");
    if (revealWorks) { await click; assert.equal(gestures.length, 1); }
    else { await assert.rejects(click, { code: "TAB_NOT_VISIBLE", uncertain: false }); assert.equal(gestures.length, 0); }
    assert.equal(revealed, 1);
  }
});
