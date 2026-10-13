import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { pixelDiff, snapshotDiff } from "../../src/core/observation-diffs.js";
import { AgentBrowserRuntime } from "../../src/core/runtime.js";
import { ArtifactStore } from "../../src/core/artifacts.js";

function image(width = 2, height = 2, changed = false) {
  const png = new PNG({ width, height }); png.data.fill(255);
  if (changed) png.data.set([0, 0, 0, 255], 0);
  return PNG.sync.write(png);
}
test("pixel diff counts pixels, bounds changes and rejects incompatible geometry", () => {
  assert.equal(pixelDiff(image(), image()).changedPixels, 0);
  const diff = pixelDiff(image(), image(2, 2, true));
  assert.equal(diff.changedPixels, 1); assert.equal(diff.changedRatio, 0.25);
  assert.deepEqual(diff.bounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual([...PNG.sync.read(diff.image).data.subarray(0, 4)], [230, 40, 110, 255]);
  assert.throws(() => pixelDiff(image(), image(3)), { code: "DIFF_SIZE_MISMATCH" });
  const bomb = image(); bomb.writeUInt32BE(0xffffffff, 16);
  assert.throws(() => pixelDiff(bomb, image()), { code: "DIFF_IMAGE_LIMIT" });
});
test("snapshot diff reports changed, added and removed controls with bounded detail", () => {
  const diff = snapshotDiff([{ selector: "#a", text: "Old" }, { selector: "#b", text: "Gone" }], [{ selector: "#a", text: "New" }, { selector: "#c", text: "Added" }], 1);
  assert.deepEqual(diff.counts, { changed: 1, added: 1, removed: 1 });
  assert.equal(diff.changed[0].after.text, "New");
});
test("baseline capability rejects another session, tab, profile, navigation and expired artifacts", async () => {
  let url = "https://example.com", label = "Old";
  const operationFactory = async () => ({ tool: {
    browser_dom_snapshot: { args: {}, execute: async () => ({ url, nodes: [{ selector: "#a", text: label }] }) },
    browser_screenshot: { args: {}, execute: async () => ({ mimeType: "image/png", base64: image().toString("base64") }) },
  } });
  const runtime = new AgentBrowserRuntime({ operationFactory, artifactStore: new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "diff-contract-")) }) });
  runtime.getSession("first").profileId = "profile";
  try {
    const captured = await runtime.invoke("browser_observation_capture", { tabId: 1, kind: "both" }, "first");
    label = "New";
    const compared = await runtime.invoke("browser_observation_diff", { tabId: 1, baseline: captured.baseline }, "first");
    assert.equal(compared.snapshot.counts.changed, 1); assert.equal(compared.pixels.changedPixels, 0);
    const args = { tabId: 1, baseline: captured.baseline };
    await assert.rejects(runtime.invoke("browser_observation_diff", args, "other"), { code: "DIFF_BASELINE_MISSING" });
    await assert.rejects(runtime.invoke("browser_observation_diff", { ...args, tabId: 2 }, "first"), { code: "DIFF_SCOPE_MISMATCH" });
    runtime.getSession("first").profileId = "other";
    await assert.rejects(runtime.invoke("browser_observation_diff", args, "first"), { code: "DIFF_SCOPE_MISMATCH" });
    runtime.getSession("first").profileId = "profile"; url = "https://example.com/new";
    await assert.rejects(runtime.invoke("browser_observation_diff", args, "first"), { code: "DIFF_NAVIGATION_CHANGED" });
    runtime.artifacts.cleanupSession("first");
    await assert.rejects(runtime.invoke("browser_observation_diff", args, "first"), { code: "DIFF_BASELINE_MISSING" });
  } finally { runtime.close(); }
});
