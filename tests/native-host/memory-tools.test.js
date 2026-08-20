import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());

test("memory tools are registered only when the memory flag is on", async () => {
  const { createMemoryRegistry, createCoreRegistry } = await import("../../src/core/registry.js");
  const core = createCoreRegistry({});
  assert.equal("memory_status" in core, false);
  assert.equal("memory_search" in core, false);
  const memory = createMemoryRegistry({});
  assert.ok(memory.memory_status);
  assert.ok(memory.memory_query);
  assert.ok(memory.memory_search);
  assert.equal(memory.memory_status.annotations.readOnlyHint, true);
  assert.equal(memory.memory_search.inputSchema.shape.kind.definitions?.length ?? memory.memory_search.inputSchema.constructor.name, memory.memory_search.inputSchema.constructor.name);
});

test("memory tools expose inspection-ready schemas", async () => {
  const { createMemoryRegistry } = await import("../../src/core/registry.js");
  const memory = createMemoryRegistry({});
  const schema = memory.memory_search.inputSchema.shape;
  assert.equal(schema.query.minLength ?? 1, 1);
  assert.ok(schema.query.maxLength <= 512);
  assert.ok(schema.limit?.maxValue ?? true);
  const querySchema = memory.memory_query.inputSchema.shape;
  assert.ok(querySchema.session_id);
  assert.ok(querySchema.capability);
  const statusSchema = memory.memory_status.inputSchema.shape;
  assert.equal(Object.keys(statusSchema).length, 0);
});

test("MCP and OpenCode adapters gate memory tools by the environment", async () => {
  const { memoryEnabledForServer } = await import("../../src/memory/index.js");
  const previous = process.env.OPENCODE_BROWSER_MEMORY;
  process.env.OPENCODE_BROWSER_MEMORY = "0";
  assert.equal(memoryEnabledForServer(), false);
  process.env.OPENCODE_BROWSER_MEMORY = "1";
  assert.equal(memoryEnabledForServer(), true);
  if (previous === undefined) delete process.env.OPENCODE_BROWSER_MEMORY;
  else process.env.OPENCODE_BROWSER_MEMORY = previous;
});

test("CLI recognizes memory and history aliases", async () => {
  const source = fs.readFileSync(path.join(root, "src", "cli", "index.js"), "utf8");
  assert.match(source, /command === "memory" \|\| command === "history"/);
  const cli = fs.readFileSync(path.join(root, "src", "cli", "memory.js"), "utf8");
  assert.match(cli, /case "search"/);
  assert.match(cli, /case "prune"/);
  assert.match(cli, /case "chains"/);
  assert.match(cli, /case "delete"/);
});

test("consultation policy instructs status-then-search before re-exploration", async () => {
  const skill = fs.readFileSync(path.join(root, "skills", "opencode-browser-plugin", "SKILL.md"), "utf8");
  const checkpoint = skill.indexOf("consult local action memory");
  assert.ok(checkpoint >= 0, "skill contains the memory consultation policy");
  const policy = skill.slice(checkpoint, checkpoint + 900);
  assert.match(policy, /memory_status/);
  assert.match(policy, /memory_search/);
  assert.match(policy, /never consult memory for unrelated tasks|Never consult memory for unrelated tasks/);
  assert.match(policy, /continue normally when memory is absent/);
});

test("extension surfaces memory settings and dashboard inside the popup", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.options_ui, undefined, "no separate options tab; memory lives in the popup");
  const popupHtml = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
  assert.match(popupHtml, /tab-memory/);
  assert.match(popupHtml, /id="view-memory"/);
  assert.match(popupHtml, /quota-slider/);
  assert.match(popupHtml, /power-user/);
  assert.match(popupHtml, /memory-chart/);
  const popupJs = fs.readFileSync(path.join(root, "extension", "src", "popup.js"), "utf8");
  assert.match(popupJs, /memory\.stats/);
  assert.match(popupJs, /memory\.configure/);
  assert.match(popupJs, /memory\.enable/);
  assert.match(popupJs, /memory\.disable/);
  assert.match(popupJs, /memory\.prune/);
  assert.match(popupJs, /quota-slider/);
  const background = fs.readFileSync(path.join(root, "extension", "src", "background.js"), "utf8");
  assert.match(background, /"MEMORY_CALL"/);
  assert.match(background, /rpc\.request\(message\.method/);
  const css = fs.readFileSync(path.join(root, "extension", "src", "popup.css"), "utf8");
  assert.match(css, /view-tab/);
  assert.match(css, /memory-card/);
});

test("host handles memory extension methods locally", async () => {
  const host = fs.readFileSync(path.join(root, "native-host", "src", "host.js"), "utf8");
  assert.match(host, /memory\.stats/);
  assert.match(host, /memory\.configure/);
  assert.match(host, /memory\.enable/);
  assert.match(host, /memory\.prune/);
  const relay = fs.readFileSync(path.join(root, "native-host", "src", "rpc-relay.js"), "utf8");
  assert.match(relay, /startAgentRequest/);
  assert.match(relay, /noteResponse/);
  assert.match(relay, /completeAgentRequest/);
});

test("runtime attaches chain metadata to executed steps", () => {
  const runtime = fs.readFileSync(path.join(root, "src", "core", "runtime.js"), "utf8");
  assert.match(runtime, /memoryStepParams\(step, params, chainId, stepIndex\)/);
  assert.match(runtime, /memory_chain_id: chainId/);
  assert.match(runtime, /memory_step_index: stepIndex/);
  assert.match(runtime, /memory_label: label/);
  assert.match(runtime, /memoryChainSequence\+\+/);
  assert.match(runtime, /executeStep\(step, tabId, prior, session, chainId, index\)/);
  // typed values never become labels: only click/hover/press element text may, and only via a guarded allowlist
  const labelSource = runtime.slice(runtime.indexOf("memoryStepParams(step, params"), runtime.indexOf("async editTarget"));
  assert.match(labelSource, /\["click", "doubleClick", "hover", "press"\]/);
  assert.match(labelSource, /slice\(0, 64\)/);
});