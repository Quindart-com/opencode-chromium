import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleVisualHostMethod, setVisualSettings, visualDataDir } from "../src/visual-map.js";

test("persists visual settings in configured local directory", () => {
  const previous = process.env.OPENCODE_BROWSER_VISUAL_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-visual-test-"));
  process.env.OPENCODE_BROWSER_VISUAL_DIR = dir;

  try {
    const status = setVisualSettings({ enabled: true, modelId: "grounding-dino-tiny", threshold: 0.33 });

    assert.equal(visualDataDir(), dir);
    assert.equal(status.settings.enabled, true);
    assert.equal(status.settings.modelId, "grounding-dino-tiny");
    assert.equal(status.settings.threshold, 0.33);
    assert.equal(fs.existsSync(path.join(dir, "settings.json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_VISUAL_DIR;
    else process.env.OPENCODE_BROWSER_VISUAL_DIR = previous;
  }
});

test("visual host method returns model metadata without loading model", async () => {
  const result = await handleVisualHostMethod("visual.listModels", {});

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "grounding-dino-tiny");
  assert.equal(result.models[0].task, "zero-shot-object-detection");
});

test("visual screenshot mapping stays disabled until enabled or forced", async () => {
  const previous = process.env.OPENCODE_BROWSER_VISUAL_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-visual-test-"));
  process.env.OPENCODE_BROWSER_VISUAL_DIR = dir;

  try {
    setVisualSettings({ enabled: false, modelId: "grounding-dino-tiny" });
    const result = await handleVisualHostMethod("visual.mapScreenshot", {});

    assert.deepEqual(result, { enabled: false, used: false, elements: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_VISUAL_DIR;
    else process.env.OPENCODE_BROWSER_VISUAL_DIR = previous;
  }
});
