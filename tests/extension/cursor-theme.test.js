import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

// The cursor theme ships as a plain content script, so it is evaluated in a
// bare context exactly the way chrome.scripting.executeScript would.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "extension-src", "public", "content-scripts", "cursor-theme.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const theme = context.__opencodeCursorTheme;

test("cursor theme exposes the ported Cua Driver constants", () => {
  assert.ok(theme, "the content script installs the cursor theme");
  assert.equal(theme.CANVAS, 128);
  assert.equal(theme.DISPLAY_SIZE, 42);
  assert.deepEqual({ ...theme.HOTSPOT }, { x: 55, y: 30 });
  assert.deepEqual(theme.DEFAULT_FILL, [94, 192, 232]);
  assert.equal(theme.SESSION_FILLS.length, 9);
});

test("the pointer silhouette matches the source vertex and tangent list", () => {
  // Each source tuple is ((vertex), in_tangent, out_tangent), so a segment from
  // vertex A to vertex B uses A + out(A) and B + in(B). The unsigned tangents on
  // the tip vertex are what keep the point sharp.
  assert.equal(
    theme.pointerPath,
    "M55 30C48 28 42 33 43 41C43 41 64 98 64 98C67 106 73 106 77 99C77 99 86 79 86 79" +
      "C88 75 91 72 95 70C95 70 108 63 108 63C115 59 114 53 107 50C107 50 55 30 55 30Z",
  );
});

test("named sessions hash into the palette while default keeps Cua blue", () => {
  assert.deepEqual(theme.sessionColor("default"), theme.DEFAULT_FILL);
  assert.deepEqual(theme.sessionColor(""), theme.DEFAULT_FILL);
  assert.deepEqual(theme.sessionColor(undefined), theme.DEFAULT_FILL);
  const named = theme.sessionColor("session-7");
  assert.deepEqual(named, theme.SESSION_FILLS[6], "a trailing number is a 1-based palette index");
  assert.deepEqual(theme.sessionColor("worker-b"), theme.SESSION_FILLS[1], "a trailing letter indexes the palette");
  assert.deepEqual(theme.sessionColor("agent-1"), theme.sessionColor("agent-1"), "hashes are stable");
  const hashed = new Set(["mcp-1", "mcp-2", "mcp-3", "mcp-4", "mcp-5", "mcp-6", "mcp-7"].map((id) => theme.sessionColor(id).join(",")));
  assert.ok(hashed.size > 1, "different sessions do not all share one colour");
  for (const id of ["mcp-alpha", "mcp-beta"]) {
    assert.ok(theme.SESSION_FILLS.some((fill) => fill.join(",") === theme.sessionColor(id).join(",")));
  }
});

test("colour mixing follows the source mix(base, session, ratio)", () => {
  assert.deepEqual(theme.mix([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
  assert.deepEqual(theme.mix([94, 151, 178], [94, 192, 232], 0.66), [94, 178, 214]);
  assert.equal(theme.cssColor([94, 192, 232]), "rgb(94,192,232)");
});

test("all twelve semantic actions exist with bounded motion", () => {
  for (const action of ["idle", "observe", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "record", "system"]) {
    assert.ok(theme.ACTIONS[action], `${action} is defined`);
    assert.ok(theme.ACTIONS[action].duration > 0, `${action} has a duration`);
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const motion = theme.actionMotion(action, progress);
      const values = [motion.group.dx, motion.group.dy, motion.group.scale, motion.group.rotate, motion.pointer.scale];
      for (const value of values) assert.ok(Number.isFinite(value), `${action} motion is finite at ${progress}`);
      for (const layer of motion.layers) {
        assert.ok(Number.isFinite(layer.opacity), `${action} layer opacity is finite at ${progress}`);
        assert.ok(Number.isFinite(layer.scale), `${action} layer scale is finite at ${progress}`);
      }
    }
  }
});

test("action artwork is emitted as addressable layers", () => {
  assert.equal(theme.cueMarkup("idle", theme.DEFAULT_FILL), "");
  for (const action of theme.ACTION_IDS.filter((id) => id !== "idle")) {
    const markup = theme.cueMarkup(action, theme.DEFAULT_FILL);
    assert.match(markup, /data-layer="0"/, `${action} exposes layer 0`);
    assert.match(markup, /rgb\(94,192,232\)/, `${action} paints with the session colour`);
    assert.match(markup, /#fff/, `${action} keeps a white outline`);
    assert.equal((markup.match(/data-layer=/g) ?? []).length, theme.ACTIONS[action].layers.length);
  }
});

test("the pointer paint stack is a glow ramp under a white outline", () => {
  const markup = theme.pointerMarkup(theme.DEFAULT_FILL);
  const glows = markup.match(/stroke-width="44"/g) ?? [];
  assert.equal(glows.length, 1, "the widest glow stroke is present");
  assert.match(markup, /stroke-width="7"/);
  assert.match(markup, /stroke="#fff" stroke-width="5"/, "the body keeps the source outline width");
  assert.match(markup, /fill="rgb\(94,192,232\)"/, "the body is filled with the session colour");
});

test("action chips are self-contained svg so they render inside the pill", () => {
  for (const action of theme.ACTION_IDS.filter((id) => id !== "idle")) {
    const glyph = theme.chipGlyph(action);
    assert.match(glyph, /^<svg viewBox="0 0 22 22"/, `${action} chip is an svg`);
    assert.match(glyph, /<\/svg>$/, `${action} chip is closed`);
  }
  assert.equal(theme.chipGlyph("idle"), "");
});

test("reduced motion resolves to a still frame inside the animation", () => {
  for (const action of theme.ACTION_IDS) {
    const still = theme.staticProgress(action);
    assert.ok(still >= 0 && still <= 1, `${action} still frame is a normalised progress`);
  }
});
