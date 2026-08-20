import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCoreRegistry } from "../../src/core/registry.js";
import { createAgentBrowserRuntime } from "../../src/core/runtime.js";

function noopRuntime() {
  return { historyStatus: async () => ({ ok: true }), historyQuery: async () => ({ ok: true }) };
}

test("core registry stays at four tools unless history is enabled", () => {
  const base = createCoreRegistry(noopRuntime());
  assert.deepEqual(Object.keys(base), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
  const withHistory = createCoreRegistry(noopRuntime(), { history: true });
  assert.deepEqual(Object.keys(withHistory), [
    "browser_run", "browser_observe", "browser_session", "browser_finalize", "history_status", "history_query",
  ]);
});

test("history_status reports a disabled store without content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-tools-"));
  const previous = process.env.OPENCODE_BROWSER_HISTORY_DIR;
  process.env.OPENCODE_BROWSER_HISTORY_DIR = root;
  try {
    const runtime = createAgentBrowserRuntime();
    const result = await runtime.historyStatus();
    assert.equal(result.ok, true);
    assert.equal(result.result.enabled, false);
    assert.equal(result.result.encrypted, true);
    assert.equal(result.result.health, "disabled");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_HISTORY_DIR;
    else process.env.OPENCODE_BROWSER_HISTORY_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history_query returns bounded metadata-only slices", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-tools-"));
  const previous = process.env.OPENCODE_BROWSER_HISTORY_DIR;
  process.env.OPENCODE_BROWSER_HISTORY_DIR = root;
  try {
    const runtime = createAgentBrowserRuntime();
    const query = await runtime.historyQuery({ limit: 10 });
    assert.equal(query.ok, true);
    assert.equal(query.result.events.length, 0);
    assert.equal(query.result.metadata_only, true);
    assert.equal(query.result.model_context_disclosure, true);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_HISTORY_DIR;
    else process.env.OPENCODE_BROWSER_HISTORY_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});