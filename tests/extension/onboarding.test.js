import assert from "node:assert/strict";
import test from "node:test";
import { openInstallGuide } from "../../extension-src/entrypoints/background/onboarding.ts";
test("install guide opens once; updates respect opt-out and do not steal focus", async () => {
  const stored = {}, opened = [];
  const chrome = { runtime: { getManifest: () => ({ version: "1.9.3" }), getURL: value => `chrome-extension://fixture/${value}` },
    storage: { local: { get: async () => stored, set: async value => Object.assign(stored, value) } }, tabs: { create: async value => opened.push(value) } };
  await openInstallGuide(chrome, { reason: "install" }); await openInstallGuide(chrome, { reason: "install" });
  assert.equal(opened.length, 1); assert.equal(opened[0].active, true);
  stored.guideVersion = "1.9.2"; stored.showReleaseNotes = false;
  await openInstallGuide(chrome, { reason: "update", previousVersion: "1.9.2" }); assert.equal(opened.length, 1);
  stored.showReleaseNotes = true;
  await openInstallGuide(chrome, { reason: "update", previousVersion: "1.9.2" }); assert.equal(opened.length, 2); assert.equal(opened[1].active, false);
  assert.equal(opened[1].url, "https://quindart-com.github.io/opencode-chromium/updates/#v1.9.3");
  await openInstallGuide(chrome, { reason: "update", previousVersion: "1.9.3" }); assert.equal(opened.length, 2);
});
