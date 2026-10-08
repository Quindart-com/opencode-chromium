import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Loads the built cursor overlay into a real page and drives it the way the
// background runtime does. No personal profile and no extension install: the
// content scripts are the artifact under test, and chrome.runtime is a fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "extension");
const themeSource = fs.readFileSync(path.join(extensionDir, "content-scripts", "cursor-theme.js"), "utf8");
const cursorSource = fs.readFileSync(path.join(extensionDir, "content-scripts", "cursor.js"), "utf8");

function runtimeFixture() {
  const state = { delivered: [], listeners: [] };
  globalThis.__cursorRuntime = state;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (value) => `chrome-extension://fixture/${value}`,
      onMessage: { addListener: (listener) => state.listeners.push(listener) },
      sendMessage: (message, callback) => {
        state.delivered.push(message);
        if (typeof callback === "function") callback({ states: state.delivered });
      },
    },
  };
  globalThis.__deliverCursor = (update) => {
    for (const listener of state.listeners) listener({ type: "OPENCODE_CURSOR_STATE", ...update }, {}, () => {});
  };
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}
  #page{height:1800px;background:#f7f8fa;font:14px system-ui}
  #page h1{padding:16px}</style></head>
  <body><div id="page"><h1>Cursor fixture</h1><button id="target" style="margin:40px">Save changes</button></div></body></html>`;

async function openPage(browser, { reducedMotion }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion });
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: `(${runtimeFixture.toString()})()` });
  await page.addScriptTag({ content: themeSource });
  await page.addScriptTag({ content: cursorSource });
  return { context, page };
}

const deliver = (page, update) => page.evaluate((value) => globalThis.__deliverCursor(value), update);
const inspect = (page) => page.evaluate(() => (globalThis.__opencodeCursorInspect ? globalThis.__opencodeCursorInspect() : null));
const arrivals = (page) => page.evaluate(() => globalThis.__cursorRuntime.delivered.filter((message) => message.type === "OPENCODE_CURSOR_ARRIVED").length);
const translation = (transform) => {
  const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(transform ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshotDir = path.join(root, "reports");

const browser = await chromium.launch({ headless: true });
try {
  fs.mkdirSync(screenshotDir, { recursive: true });

  // --- precise geometry, palette and labels (reduced motion is deterministic)
  {
    const { context, page } = await openPage(browser, { reducedMotion: "reduce" });

    assert.deepEqual(await inspect(page), [], "no cursor exists until the background publishes one");

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 300, y: 220, moveSequence: 1, action: "navigate" });
    const revealedAt = Date.now();

    const host = await page.evaluate(() => {
      const element = document.getElementById("opencode-agent-cursor-root");
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scripts: typeof globalThis.__opencodeCursorInspect,
      };
    });
    assert.ok(host, "the overlay host is attached when the first cursor appears");
    assert.equal(host.pointerEvents, "none", "the overlay never intercepts page input");
    assert.equal(host.zIndex, "2147483647", "the overlay stays above page content");
    assert.equal(host.scrollWidth, host.clientWidth, "the overlay never adds a scrollbar");
    assert.equal(host.scripts, "function");

    let [alpha] = await inspect(page);
    assert.equal(alpha.cursorId, "alpha");
    assert.equal(alpha.visible, true);
    assert.equal(alpha.label, "Alpha Agent");
    assert.equal(alpha.labelVisible, true, "the label is revealed with the cursor");
    assert.equal(alpha.fill.length, 3);
    assert.notDeepEqual(alpha.fill, [94, 192, 232], "a named session is tinted away from the Cua blue key colour");
    assert.equal(await arrivals(page), 1, "the first published sequence reports arrival");

    // The hotspot is the rotation pivot, so under reduced motion the reported
    // coordinate and the rendered offset must agree exactly.
    assert.deepEqual({ x: alpha.x, y: alpha.y }, { x: 300, y: 220 });
    assert.deepEqual(translation(alpha.transform), { x: 300, y: 220 }, "the tip lands on the requested point");
    assert.match(alpha.artTransform, /rotate\(0deg\)/, "the artwork is unrotated at the source heading");

    // The label holds for two seconds and then fades out on its own. The waits are
    // deadlines measured from the reveal, so slow assertions cannot drift past the
    // hold on a slower runner.
    await sleep(Math.max(0, 1_500 - (Date.now() - revealedAt)));
    assert.equal((await inspect(page))[0].labelVisible, true, "the label is still held at 1.5s");
    await sleep(Math.max(0, 2_600 - (Date.now() - revealedAt)));
    assert.equal((await inspect(page))[0].labelVisible, false, "the label fades after the hold");

    // The default session is the one that keeps the Cua blue.
    await deliver(page, { cursorId: "default", label: "OpenCode", x: 640, y: 200, moveSequence: 1 });
    const plain = (await inspect(page)).find((entry) => entry.cursorId === "default");
    assert.deepEqual(plain.fill, [94, 192, 232], "the default agent keeps Cua blue");
    assert.equal(plain.label, "OpenCode");

    // A second session is a second cursor with its own colour.
    await deliver(page, { cursorId: "beta", label: "Beta Worker", x: 520, y: 380, moveSequence: 1 });
    const both = await inspect(page);
    assert.equal(both.length, 3, "sessions keep independent cursors");
    assert.notDeepEqual(both[0].fill, both[1].fill, "each session gets its own cursor colour");
    assert.equal(both.at(-1).label, "Beta Worker");

    await deliver(page, { cursorId: "long-label", label: "A session name that is far too long to fit in the pill", x: 40, y: 40, moveSequence: 1 });
    const labelled = (await inspect(page)).find((entry) => entry.cursorId === "long-label");
    assert.equal(labelled.label.length, 28, "the pill truncates at the source limit");
    assert.match(labelled.label, /…$/);

    // Hiding is explicit and always answers the arrival waiter once.
    const before = await arrivals(page);
    await deliver(page, { cursorId: "alpha", x: 300, y: 220, moveSequence: 2, visible: false });
    assert.equal((await inspect(page)).find((entry) => entry.cursorId === "alpha").visible, false);
    assert.equal(await arrivals(page), before + 1, "a hidden cursor still answers its arrival waiter");

    // The host survives page mutations that would otherwise orphan it.
    await page.evaluate(() => document.body.insertAdjacentHTML("afterbegin", "<div>re-render</div>"));
    assert.equal((await inspect(page)).length, 4, "the overlay is unaffected by host page re-renders");
    await context.close();
  }

  // --- motion, action animations and arrival protocol
  {
    const { context, page } = await openPage(browser, { reducedMotion: "no-preference" });

    // Sampling runs inside the page on the frame loop the overlay itself uses, so
    // a fast machine cannot finish the glide between two driver round trips.
    await page.evaluate(() => {
      const samples = [];
      globalThis.__cursorSamples = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 90) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action: "navigate" });
    await sleep(700);
    const samples = await page.evaluate(() => globalThis.__cursorSamples);
    const settled = (await inspect(page))[0];
    assert.ok(samples.length > 5, `the frame loop produced samples, got ${samples.length}`);
    const start = samples[0];
    assert.ok(Math.abs(start.x - 620) > 100 || Math.abs(start.y - 480) > 100, "the first reveal starts away from the target and glides in");
    assert.ok(samples.some((sample) => sample.x > start.x + 2 && sample.x < 617), "the pointer is observed in flight, not snapped");
    assert.deepEqual({ x: settled.x, y: settled.y }, { x: 620, y: 480 }, "the glide settles exactly on the target");
    assert.equal(await arrivals(page), 1, "a completed glide reports arrival once");

    for (const [action, layers] of [["click", 3], ["text", 1], ["scroll", 2], ["drag", 2], ["observe", 2], ["system", 1]]) {
      await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action });
      const entry = (await inspect(page))[0];
      assert.equal(entry.action, action, `${action} is playing`);
      assert.equal(entry.cueAction, action, `${action} artwork is mounted`);
      assert.equal(entry.layers, layers, `${action} exposes its cue layers`);
    }

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action: "idle" });
    const idle = (await inspect(page))[0];
    assert.equal(idle.action, "idle");
    assert.equal(idle.layers, 0, "the resting cursor carries no cue artwork");

    // Screenshots are the visual record for review.
    for (const action of ["idle", "click", "text", "scroll", "observe"]) {
      await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 300, y: 260, moveSequence: 1, action });
      await sleep(180);
      await page.screenshot({ path: path.join(screenshotDir, `cursor-${action}.png`), clip: { x: 190, y: 200, width: 230, height: 130 } });
    }
    await context.close();
  }

  // --- reduced motion offers a still frame instead of an animation loop
  {
    const { context, page } = await openPage(browser, { reducedMotion: "reduce" });
    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 410, y: 330, moveSequence: 7, action: "click" });
    const entry = (await inspect(page))[0];
    assert.deepEqual({ x: entry.x, y: entry.y }, { x: 410, y: 330 }, "reduced motion never interpolates");
    assert.equal(entry.action, "click", "the action still paints its still frame");
    assert.equal(await arrivals(page), 1);
    await context.close();
  }

  // --- an unwatched tab places the pointer instead of animating it
  {
    const { context, page } = await openPage(browser, { reducedMotion: "no-preference" });
    // hasFocus and hidden are read-only, so the fixture drives them directly and
    // dispatches the events the overlay listens for.
    await page.evaluate(() => {
      let focused = true;
      globalThis.__setFocus = (value) => {
        focused = value;
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => !focused && globalThis.__hardHidden === true });
        window.dispatchEvent(new Event(value ? "focus" : "blur"));
        document.dispatchEvent(new Event("visibilitychange"));
      };
      globalThis.__setFocus(true);
    });

    // Watched: the pointer is observed travelling, as before.
    await page.evaluate(() => {
      const samples = [];
      globalThis.__watched = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 60) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await deliver(page, { cursorId: "watched", label: "Watched", x: 700, y: 500, moveSequence: 1, action: "click" });
    await sleep(600);
    const watched = await page.evaluate(() => globalThis.__watched);
    assert.ok(watched.some((sample) => sample.x > 5 && sample.x < 695), "a focused window animates the move");

    // Unfocused: no frames are spent, and the pointer is simply placed.
    await page.evaluate(() => globalThis.__setFocus(false));
    await deliver(page, { cursorId: "watched", label: "Watched", x: 120, y: 90, moveSequence: 2, action: "click" });
    const placed = (await inspect(page))[0];
    assert.deepEqual({ x: placed.x, y: placed.y }, { x: 120, y: 90 }, "an unfocused window places the pointer at the target");

    // Start recording only after the move is delivered and its immediate
    // placement is confirmed, so a slow runner cannot capture the old position.
    await page.evaluate(() => {
      const samples = [];
      globalThis.__unwatched = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 60) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await sleep(200);
    const unwatched = await page.evaluate(() => globalThis.__unwatched);
    assert.ok(unwatched.every((sample) => sample.x === 120 && sample.y === 90), "nothing is animated while the window is unfocused");
    assert.equal(await arrivals(page), 2, "an unwatched move still answers its arrival waiter");

    // Refocusing reveals the label again without moving a pointer that is
    // already on its target.
    await page.evaluate(() => globalThis.__setFocus(true));
    await sleep(80);
    const refocused = (await inspect(page))[0];
    assert.deepEqual({ x: refocused.x, y: refocused.y }, { x: 120, y: 90 }, "refocusing does not move the pointer");
    assert.equal(refocused.labelVisible, true, "the label returns with focus so the session is identifiable");
    await context.close();
  }

  console.log("Cursor browser checks passed: host isolation, hotspot accuracy, per-session palette, label hold and truncation, glide motion, six action animations, arrival protocol, reduced motion, focus gating.");

  // --- reference stills
  // The Cua Driver renders its 128 canvas at 128/48 backing scale; capturing the
  // 42px footprint at deviceScaleFactor 3 gives the same 126px artwork, so the
  // two sets can be compared side by side by eye.
  {
    const context = await browser.newContext({ viewport: { width: 400, height: 320 }, deviceScaleFactor: 3, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.setContent(FIXTURE);
    await page.addScriptTag({ content: `(${runtimeFixture.toString()})()` });
    await page.addScriptTag({ content: themeSource });
    await page.addScriptTag({ content: cursorSource });
    for (const action of ["idle", "observe", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "record", "system"]) {
      await deliver(page, { cursorId: "reference", label: "Reference", x: 200, y: 160, moveSequence: 1, action });
      await sleep(60);
      await page.screenshot({ path: path.join(screenshotDir, `cursor-reference-${action}.png`), clip: { x: 136, y: 130, width: 126, height: 126 } });
    }
    await context.close();
    console.log("Reference stills written to reports/cursor-reference-*.png for review.");
  }
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Loads the built cursor overlay into a real page and drives it the way the
// background runtime does. No personal profile and no extension install: the
// content scripts are the artifact under test, and chrome.runtime is a fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "extension");
const themeSource = fs.readFileSync(path.join(extensionDir, "content-scripts", "cursor-theme.js"), "utf8");
const cursorSource = fs.readFileSync(path.join(extensionDir, "content-scripts", "cursor.js"), "utf8");

function runtimeFixture() {
  const state = { delivered: [], listeners: [] };
  globalThis.__cursorRuntime = state;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (value) => `chrome-extension://fixture/${value}`,
      onMessage: { addListener: (listener) => state.listeners.push(listener) },
      sendMessage: (message, callback) => {
        state.delivered.push(message);
        if (typeof callback === "function") callback({ states: state.delivered });
      },
    },
  };
  globalThis.__deliverCursor = (update) => {
    for (const listener of state.listeners) listener({ type: "OPENCODE_CURSOR_STATE", ...update }, {}, () => {});
  };
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}
  #page{height:1800px;background:#f7f8fa;font:14px system-ui}
  #page h1{padding:16px}</style></head>
  <body><div id="page"><h1>Cursor fixture</h1><button id="target" style="margin:40px">Save changes</button></div></body></html>`;

async function openPage(browser, { reducedMotion }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion });
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: `(${runtimeFixture.toString()})()` });
  await page.addScriptTag({ content: themeSource });
  await page.addScriptTag({ content: cursorSource });
  return { context, page };
}

const deliver = (page, update) => page.evaluate((value) => globalThis.__deliverCursor(value), update);
const inspect = (page) => page.evaluate(() => (globalThis.__opencodeCursorInspect ? globalThis.__opencodeCursorInspect() : null));
const arrivals = (page) => page.evaluate(() => globalThis.__cursorRuntime.delivered.filter((message) => message.type === "OPENCODE_CURSOR_ARRIVED").length);
const translation = (transform) => {
  const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(transform ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshotDir = path.join(root, "reports");

const browser = await chromium.launch({ headless: true });
try {
  fs.mkdirSync(screenshotDir, { recursive: true });

  // --- precise geometry, palette and labels (reduced motion is deterministic)
  {
    const { context, page } = await openPage(browser, { reducedMotion: "reduce" });

    assert.deepEqual(await inspect(page), [], "no cursor exists until the background publishes one");

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 300, y: 220, moveSequence: 1, action: "navigate" });
    const revealedAt = Date.now();

    const host = await page.evaluate(() => {
      const element = document.getElementById("opencode-agent-cursor-root");
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scripts: typeof globalThis.__opencodeCursorInspect,
      };
    });
    assert.ok(host, "the overlay host is attached when the first cursor appears");
    assert.equal(host.pointerEvents, "none", "the overlay never intercepts page input");
    assert.equal(host.zIndex, "2147483647", "the overlay stays above page content");
    assert.equal(host.scrollWidth, host.clientWidth, "the overlay never adds a scrollbar");
    assert.equal(host.scripts, "function");

    let [alpha] = await inspect(page);
    assert.equal(alpha.cursorId, "alpha");
    assert.equal(alpha.visible, true);
    assert.equal(alpha.label, "Alpha Agent");
    assert.equal(alpha.labelVisible, true, "the label is revealed with the cursor");
    assert.equal(alpha.fill.length, 3);
    assert.notDeepEqual(alpha.fill, [94, 192, 232], "a named session is tinted away from the Cua blue key colour");
    assert.equal(await arrivals(page), 1, "the first published sequence reports arrival");

    // The hotspot is the rotation pivot, so under reduced motion the reported
    // coordinate and the rendered offset must agree exactly.
    assert.deepEqual({ x: alpha.x, y: alpha.y }, { x: 300, y: 220 });
    assert.deepEqual(translation(alpha.transform), { x: 300, y: 220 }, "the tip lands on the requested point");
    assert.match(alpha.artTransform, /rotate\(0deg\)/, "the artwork is unrotated at the source heading");

    // The label holds for two seconds and then fades out on its own. The waits are
    // deadlines measured from the reveal, so slow assertions cannot drift past the
    // hold on a slower runner.
    await sleep(Math.max(0, 1_500 - (Date.now() - revealedAt)));
    assert.equal((await inspect(page))[0].labelVisible, true, "the label is still held at 1.5s");
    await sleep(Math.max(0, 2_600 - (Date.now() - revealedAt)));
    assert.equal((await inspect(page))[0].labelVisible, false, "the label fades after the hold");

    // The default session is the one that keeps the Cua blue.
    await deliver(page, { cursorId: "default", label: "OpenCode", x: 640, y: 200, moveSequence: 1 });
    const plain = (await inspect(page)).find((entry) => entry.cursorId === "default");
    assert.deepEqual(plain.fill, [94, 192, 232], "the default agent keeps Cua blue");
    assert.equal(plain.label, "OpenCode");

    // A second session is a second cursor with its own colour.
    await deliver(page, { cursorId: "beta", label: "Beta Worker", x: 520, y: 380, moveSequence: 1 });
    const both = await inspect(page);
    assert.equal(both.length, 3, "sessions keep independent cursors");
    assert.notDeepEqual(both[0].fill, both[1].fill, "each session gets its own cursor colour");
    assert.equal(both.at(-1).label, "Beta Worker");

    await deliver(page, { cursorId: "long-label", label: "A session name that is far too long to fit in the pill", x: 40, y: 40, moveSequence: 1 });
    const labelled = (await inspect(page)).find((entry) => entry.cursorId === "long-label");
    assert.equal(labelled.label.length, 28, "the pill truncates at the source limit");
    assert.match(labelled.label, /…$/);

    // Hiding is explicit and always answers the arrival waiter once.
    const before = await arrivals(page);
    await deliver(page, { cursorId: "alpha", x: 300, y: 220, moveSequence: 2, visible: false });
    assert.equal((await inspect(page)).find((entry) => entry.cursorId === "alpha").visible, false);
    assert.equal(await arrivals(page), before + 1, "a hidden cursor still answers its arrival waiter");

    // The host survives page mutations that would otherwise orphan it.
    await page.evaluate(() => document.body.insertAdjacentHTML("afterbegin", "<div>re-render</div>"));
    assert.equal((await inspect(page)).length, 4, "the overlay is unaffected by host page re-renders");
    await context.close();
  }

  // --- motion, action animations and arrival protocol
  {
    const { context, page } = await openPage(browser, { reducedMotion: "no-preference" });

    // Sampling runs inside the page on the frame loop the overlay itself uses, so
    // a fast machine cannot finish the glide between two driver round trips.
    await page.evaluate(() => {
      const samples = [];
      globalThis.__cursorSamples = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 90) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action: "navigate" });
    await sleep(700);
    const samples = await page.evaluate(() => globalThis.__cursorSamples);
    const settled = (await inspect(page))[0];
    assert.ok(samples.length > 5, `the frame loop produced samples, got ${samples.length}`);
    const start = samples[0];
    assert.ok(Math.abs(start.x - 620) > 100 || Math.abs(start.y - 480) > 100, "the first reveal starts away from the target and glides in");
    assert.ok(samples.some((sample) => sample.x > start.x + 2 && sample.x < 617), "the pointer is observed in flight, not snapped");
    assert.deepEqual({ x: settled.x, y: settled.y }, { x: 620, y: 480 }, "the glide settles exactly on the target");
    assert.equal(await arrivals(page), 1, "a completed glide reports arrival once");

    for (const [action, layers] of [["click", 3], ["text", 1], ["scroll", 2], ["drag", 2], ["observe", 2], ["system", 1]]) {
      await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action });
      const entry = (await inspect(page))[0];
      assert.equal(entry.action, action, `${action} is playing`);
      assert.equal(entry.cueAction, action, `${action} artwork is mounted`);
      assert.equal(entry.layers, layers, `${action} exposes its cue layers`);
    }

    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 620, y: 480, moveSequence: 1, action: "idle" });
    const idle = (await inspect(page))[0];
    assert.equal(idle.action, "idle");
    assert.equal(idle.layers, 0, "the resting cursor carries no cue artwork");

    // Screenshots are the visual record for review.
    for (const action of ["idle", "click", "text", "scroll", "observe"]) {
      await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 300, y: 260, moveSequence: 1, action });
      await sleep(180);
      await page.screenshot({ path: path.join(screenshotDir, `cursor-${action}.png`), clip: { x: 190, y: 200, width: 230, height: 130 } });
    }
    await context.close();
  }

  // --- reduced motion offers a still frame instead of an animation loop
  {
    const { context, page } = await openPage(browser, { reducedMotion: "reduce" });
    await deliver(page, { cursorId: "alpha", label: "Alpha Agent", x: 410, y: 330, moveSequence: 7, action: "click" });
    const entry = (await inspect(page))[0];
    assert.deepEqual({ x: entry.x, y: entry.y }, { x: 410, y: 330 }, "reduced motion never interpolates");
    assert.equal(entry.action, "click", "the action still paints its still frame");
    assert.equal(await arrivals(page), 1);
    await context.close();
  }

  // --- an unwatched tab places the pointer instead of animating it
  {
    const { context, page } = await openPage(browser, { reducedMotion: "no-preference" });
    // hasFocus and hidden are read-only, so the fixture drives them directly and
    // dispatches the events the overlay listens for.
    await page.evaluate(() => {
      let focused = true;
      globalThis.__setFocus = (value) => {
        focused = value;
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => !focused && globalThis.__hardHidden === true });
        window.dispatchEvent(new Event(value ? "focus" : "blur"));
        document.dispatchEvent(new Event("visibilitychange"));
      };
      globalThis.__setFocus(true);
    });

    // Watched: the pointer is observed travelling, as before.
    await page.evaluate(() => {
      const samples = [];
      globalThis.__watched = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 60) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await deliver(page, { cursorId: "watched", label: "Watched", x: 700, y: 500, moveSequence: 1, action: "click" });
    await sleep(600);
    const watched = await page.evaluate(() => globalThis.__watched);
    assert.ok(watched.some((sample) => sample.x > 5 && sample.x < 695), "a focused window animates the move");

    // Unfocused: no frames are spent, and the pointer is simply placed.
    await page.evaluate(() => {
      globalThis.__setFocus(false);
      const samples = [];
      globalThis.__unwatched = samples;
      const record = () => {
        const entry = globalThis.__opencodeCursorInspect?.()[0];
        if (entry) samples.push({ x: entry.x, y: entry.y });
        if (samples.length < 60) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await deliver(page, { cursorId: "watched", label: "Watched", x: 120, y: 90, moveSequence: 2, action: "click" });
    const placed = (await inspect(page))[0];
    assert.deepEqual({ x: placed.x, y: placed.y }, { x: 120, y: 90 }, "an unfocused window places the pointer at the target");
    await sleep(200);
    const unwatched = await page.evaluate(() => globalThis.__unwatched);
    assert.ok(unwatched.every((sample) => sample.x === 120 && sample.y === 90), "nothing is animated while the window is unfocused");
    assert.equal(await arrivals(page), 2, "an unwatched move still answers its arrival waiter");

    // Refocusing reveals the label again without moving a pointer that is
    // already on its target.
    await page.evaluate(() => globalThis.__setFocus(true));
    await sleep(80);
    const refocused = (await inspect(page))[0];
    assert.deepEqual({ x: refocused.x, y: refocused.y }, { x: 120, y: 90 }, "refocusing does not move the pointer");
    assert.equal(refocused.labelVisible, true, "the label returns with focus so the session is identifiable");
    await context.close();
  }

  console.log("Cursor browser checks passed: host isolation, hotspot accuracy, per-session palette, label hold and truncation, glide motion, six action animations, arrival protocol, reduced motion, focus gating.");

  // --- reference stills
  // The Cua Driver renders its 128 canvas at 128/48 backing scale; capturing the
  // 42px footprint at deviceScaleFactor 3 gives the same 126px artwork, so the
  // two sets can be compared side by side by eye.
  {
    const context = await browser.newContext({ viewport: { width: 400, height: 320 }, deviceScaleFactor: 3, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.setContent(FIXTURE);
    await page.addScriptTag({ content: `(${runtimeFixture.toString()})()` });
    await page.addScriptTag({ content: themeSource });
    await page.addScriptTag({ content: cursorSource });
    for (const action of ["idle", "observe", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "record", "system"]) {
      await deliver(page, { cursorId: "reference", label: "Reference", x: 200, y: 160, moveSequence: 1, action });
      await sleep(60);
      await page.screenshot({ path: path.join(screenshotDir, `cursor-reference-${action}.png`), clip: { x: 136, y: 130, width: 126, height: 126 } });
    }
    await context.close();
    console.log("Reference stills written to reports/cursor-reference-*.png for review.");
  }
} finally {
  await browser.close();
}
