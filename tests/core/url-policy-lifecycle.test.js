import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AgentBrowserRuntime } from "../../src/core/runtime.ts";

test("redirect policy blocks subsequent reads and allows explicit recovery navigation", async () => {
  let url = "https://allowed.test", reads = 0;
  const args = { tabId: z.number().optional(), url: z.string().optional() };
  const runtime = new AgentBrowserRuntime({ urlPolicyConfig: { allowedOrigins: ["allowed.test"] }, operationFactory: async () => ({ tool: {
    browser_get_tab: { args, execute: async () => ({ id: 1, url }) },
    browser_navigate: { args, execute: async input => { url = input.url.endsWith("/redirect") ? "https://blocked.test/private" : input.url; return {}; } },
    browser_dom_snapshot: { args, execute: async () => { reads++; return {}; } },
  } }) });
  try {
    await assert.rejects(runtime.invoke("browser_navigate", { tabId: 1, url: "https://allowed.test/redirect" }, "session"), { code: "URL_POLICY_BLOCKED" });
    await assert.rejects(runtime.invoke("browser_dom_snapshot", { tabId: 1 }, "session"), { code: "URL_POLICY_BLOCKED" }); assert.equal(reads, 0);
    await runtime.invoke("browser_navigate", { tabId: 1, url: "https://allowed.test" }, "session");
    await runtime.invoke("browser_dom_snapshot", { tabId: 1 }, "session"); assert.equal(reads, 1);
  } finally { runtime.close(); }
});
test("unrestricted sessions do not add per-operation tab queries", async () => {
  let lookups = 0;
  const runtime = new AgentBrowserRuntime({ operationFactory: async () => ({ tool: {
    browser_get_tab: { args: {}, execute: async () => { lookups++; return {}; } },
    browser_dom_snapshot: { args: { tabId: z.number() }, execute: async () => ({ nodes: [] }) },
  } }) });
  try { await runtime.invoke("browser_dom_snapshot", { tabId: 1 }, "session"); assert.equal(lookups, 0); }
  finally { runtime.close(); }
});
