import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { boundedFrameTree, webMcpDiscoveryExpression, createDiscoveryOperations } from "../../src/browser/discovery.js";
import { createUrlPolicy } from "../../src/browser/url-policy.js";
const frame = (id, children = []) => ({ frame: { id, url: "https://example.com" }, childFrames: children });
test("frame traversal caps breadth and depth and identifies parents", () => {
  const tree = frame("root", [frame("child", [frame("nested")]), ...Array.from({ length: 100 }, (_, i) => frame(`f${i}`))]);
  const result = boundedFrameTree(tree, { maxDepth: 1, maxFrames: 4 });
  assert.equal(result.frames.length, 4); assert.equal(result.frames[1].parentId, "root"); assert.equal(result.truncated, true);
});
test("WebMCP discovery bounds untrusted schemas and never executes tools", async () => {
  let executions = 0;
  const document = { modelContext: { getTools: async () => Array.from({ length: 40 }, (_, i) => ({ name: `tool${i}`, description: "x".repeat(2000), inputSchema: { properties: Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`f${n}`, { type: "string", description: "x".repeat(300) }])) }, execute: () => executions++ })) } };
  const result = await vm.runInNewContext(webMcpDiscoveryExpression({ limit: 3, maxSchemaChars: 100 }), { document, navigator: {}, location: { origin: "https://example.com" }, setTimeout, clearTimeout });
  assert.equal(result.tools.length, 3); assert.equal(result.tools[0].description.length, 500);
  assert.equal(result.tools[0].schemaTruncated, true); assert.equal(result.tools[0].inputSchema, null);
  assert.equal(result.executionEnabled, false); assert.equal(result.untrusted, true); assert.equal(executions, 0);
  const unavailable = await vm.runInNewContext(webMcpDiscoveryExpression(), { document: {}, navigator: {} });
  assert.equal(unavailable.supported, false);
});
test("blocked frame cannot be inspected and stale IDs cannot select another frame", async () => {
  let reads = 0;
  const operations = createDiscoveryOperations({ getTab: async () => ({ url: "https://example.com" }), command: async (_ctx, _tab, method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://example.com" }, childFrames: [{ frame: { id: "blocked", url: "https://blocked.test" } }] } };
    reads++; return {};
  } });
  const context = { urlPolicy: createUrlPolicy({ blockedOrigins: ["blocked.test"] }) };
  await assert.rejects(operations.browser_frame_inspect.execute({ tabId: 1, frameId: "blocked", maxDepth: 3, maxFrames: 20 }, context), { code: "URL_POLICY_BLOCKED" });
  await assert.rejects(operations.browser_frame_inspect.execute({ tabId: 1, frameId: "stale", maxDepth: 3, maxFrames: 20 }, context), { code: "FRAME_NOT_FOUND" });
  assert.equal(reads, 0);
});
