import assert from "node:assert/strict";
import test from "node:test";
import { createCoreRegistry } from "../../src/core/registry.js";
import { toolDefinitionsForDialect } from "../../src/core/schema-adapters.js";

const runtime = {
  run() {}, observe() {}, session() {}, finalize() {},
};

test("core registry exposes only the four AI-facing tools", () => {
  const registry = createCoreRegistry(runtime);
  assert.deepEqual(Object.keys(registry), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
});

test("provider dialects share one compact canonical schema", () => {
  const registry = createCoreRegistry(runtime);
  for (const dialect of ["mcp", "openai", "anthropic", "gemini"]) {
    const tools = toolDefinitionsForDialect(registry, dialect);
    assert.equal(tools.length, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(tools)) < 8000, `${dialect} schema budget`);
  }
});

test("typed run schema rejects arbitrary code and oversized chains", () => {
  const schema = createCoreRegistry(runtime).browser_run.inputSchema;
  assert.equal(schema.safeParse({ steps: [{ action: "evaluate", code: "alert(1)" }] }).success, false);
  assert.equal(schema.safeParse({ steps: Array.from({ length: 21 }, () => ({ action: "find", value: "save" })) }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "wait" }] }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "navigate", url: "javascript:alert(1)" }] }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "navigate", url: "about:blank" }] }).success, true);
  assert.equal(schema.safeParse({ approvalToken: "approved-request" }).success, true);
  assert.equal(schema.safeParse({ steps: [{ action: "press", key: "CTRL+A" }], maxChars: 500000 }).success, true);
});

test("v0.2 observation and session schemas omit core-v1 aliases", () => {
  const registry = createCoreRegistry(runtime);
  assert.equal(registry.browser_observe.inputSchema.safeParse({ mode: "state" }).success, false);
  assert.equal(registry.browser_observe.inputSchema.safeParse({ mode: "inspect", limit: 99999 }).success, true);
  assert.equal(registry.browser_session.inputSchema.safeParse({ action: "select-profile" }).success, false);
  assert.equal(registry.browser_session.inputSchema.safeParse({ action: "inspect-state" }).success, false);
});
