import assert from "node:assert/strict";
import { test } from "bun:test";

test("memory tools are registered only when the memory flag is on", async () => {
  const { createMemoryRegistry, createCoreRegistry } = await import("../../src/core/registry.ts");
  const core = createCoreRegistry({});
  assert.equal("memory_status" in core, false);
  assert.equal("memory_search" in core, false);
  const memory = createMemoryRegistry({});
  assert.ok(memory.memory_status);
  assert.ok(memory.memory_query);
  assert.ok(memory.memory_search);
  assert.equal(memory.memory_status.annotations.readOnlyHint, true);
});

test("memory tools expose inspection-ready schemas", async () => {
  const { createMemoryRegistry } = await import("../../src/core/registry.ts");
  const memory = createMemoryRegistry({});
  const schema = memory.memory_search.inputSchema.shape;
  assert.equal(schema.query.safeParse("").success, false);
  assert.ok(schema.query.maxLength <= 512);
  assert.equal(schema.limit.safeParse(21).success, false);
  const querySchema = memory.memory_query.inputSchema.shape;
  assert.ok(querySchema.session_id);
  assert.ok(querySchema.capability);
  const statusSchema = memory.memory_status.inputSchema.shape;
  assert.ok(statusSchema.sessionId, "sessionId is advertised for opencode session tools");
  assert.ok(statusSchema.profile);
});

test("MCP and OpenCode adapters gate memory tools by the environment", async () => {
  const { memoryEnabledForServer } = await import("../../src/memory/index.ts");
  const previous = process.env.OPENCODE_BROWSER_MEMORY;
  process.env.OPENCODE_BROWSER_MEMORY = "0";
  assert.equal(memoryEnabledForServer(), false);
  process.env.OPENCODE_BROWSER_MEMORY = "1";
  assert.equal(memoryEnabledForServer(), true);
  if (previous === undefined) delete process.env.OPENCODE_BROWSER_MEMORY;
  else process.env.OPENCODE_BROWSER_MEMORY = previous;
});
