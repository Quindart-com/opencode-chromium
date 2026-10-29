import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createCoreRegistry } from "../../src/core/registry.ts";

const runtime = {
  run() {}, observe() {}, session() {}, finalize() {},
};

test("typed run schema rejects arbitrary code and oversized chains", () => {
  const schema = createCoreRegistry(runtime).browser_run.inputSchema;
  assert.equal(schema.safeParse({ steps: [{ action: "evaluate", code: "alert(1)" }] }).success, false);
  assert.equal(schema.safeParse({ steps: Array.from({ length: 21 }, () => ({ action: "find", value: "save" })) }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "wait" }] }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "navigate", url: "javascript:alert(1)" }] }).success, false);
  assert.equal(schema.safeParse({ steps: [{ action: "navigate", url: "about:blank" }] }).success, true);
  assert.equal(schema.safeParse({ approvalToken: randomUUID() }).success, true);
  assert.equal(schema.safeParse({ steps: [{ action: "press", key: "CTRL+A" }], maxChars: 500000 }).success, true);
});

test("v0.2 observation and session schemas omit core-v1 aliases", () => {
  const registry = createCoreRegistry(runtime);
  assert.equal(registry.browser_observe.inputSchema.safeParse({ mode: "state" }).success, false);
  assert.equal(registry.browser_observe.inputSchema.safeParse({ mode: "inspect", limit: 99999 }).success, true);
  assert.equal(registry.browser_session.inputSchema.safeParse({ action: "select-profile" }).success, false);
  assert.equal(registry.browser_session.inputSchema.safeParse({ action: "inspect-state" }).success, false);
});
