import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const entryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".opencode", "plugins", "opencode-browser-adapter.js");
const entry = await import(pathToFileURL(entryPath).href);

test("opencode entry exposes the same four tools as the codex adapter", async () => {
  const hooks = await entry.OpencodeBrowserAdapter({ directory: process.cwd(), worktree: process.cwd() });
  const tools = hooks.tool ?? {};
  assert.deepEqual(Object.keys(tools), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
  for (const definition of Object.values(tools)) {
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.args && typeof definition.args === "object");
    assert.equal(typeof definition.execute, "function");
  }
});

test("opencode entry registers tools only once when loaded twice", async () => {
  const hooks = await entry.OpencodeBrowserAdapter({ directory: process.cwd(), worktree: process.cwd() });
  assert.deepEqual(hooks, {});
});
