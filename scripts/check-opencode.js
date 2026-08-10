#!/usr/bin/env node

import assert from "node:assert/strict";
import plugin, { createOpenCodeSetup } from "../src/adapters/opencode/index.js";

const calls = [];
const ctx = {
  tools: { add: async (name, definition) => calls.push({ name, definition }) },
  logger: { info() {}, warn() {}, error() {} },
};
const cleanup = await createOpenCodeSetup(ctx);
try {
  assert.equal(typeof plugin, "object");
  assert.equal(typeof plugin.server, "function");
  assert.equal(plugin.id, "opencode-browser-plugin");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.name), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
  assert.ok(calls.every((call) => call.definition.codemode === false));
  console.log(JSON.stringify({ ok: true, plugin: plugin.id, tools: calls.map((call) => call.name) }, null, 2));
} finally {
  await cleanup();
}

const legacyHooks = await plugin.server({});
try {
  assert.deepEqual(Object.keys(legacyHooks.tool ?? {}), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
} finally {
  await legacyHooks.dispose();
}
