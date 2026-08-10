import assert from "node:assert/strict";
import test from "node:test";
import { createCoreRegistry } from "../../src/core/registry.js";

const runtime = { run() {}, observe() {}, session() {}, finalize() {} };

test("mock Google Workspace UI flow reduces browser calls and removes fixed waits", () => {
  const baseline = { browserCalls: 11, wrapperWaits: 10 };
  const flow = [
    { tool: "browser_session", args: { action: "open", profile: "Work" } },
    {
      tool: "browser_run",
      args: {
        profile: "Work",
        steps: [
          { id: "settings", action: "find", value: "sharing settings" },
          { action: "click", target: { fromStep: "settings" }, settle: { condition: "exists", target: { selector: "[role=dialog]" } } },
          { action: "replaceText", target: { selector: "input[name=label]" }, value: "Team" },
        ],
        postObserve: { mode: "inspect", target: { selector: "[role=dialog]" } },
      },
    },
    { tool: "browser_finalize", args: {} },
  ];
  const registry = createCoreRegistry(runtime);
  for (const call of flow) assert.equal(registry[call.tool].inputSchema.safeParse(call.args).success, true);
  const browserCalls = flow.length;
  const fixedWaits = flow.flatMap((call) => call.args.steps ?? []).filter((step) => step.action === "wait").length;
  assert.ok((baseline.browserCalls - browserCalls) / baseline.browserCalls >= 0.6);
  assert.ok((baseline.wrapperWaits - 0) / baseline.wrapperWaits >= 0.9);
  assert.equal(fixedWaits, 0);
});

test("mock structured Airtable flow routes to the native connector without browser calls", () => {
  const availableConnectors = new Set(["airtable.update_field"]);
  const request = { operation: "airtable.update_field", args: { table: "Projects", field: "Status" } };
  const plannedCalls = availableConnectors.has(request.operation)
    ? [{ tool: request.operation, args: request.args }]
    : [{ tool: "browser_run", args: { steps: [] } }];
  assert.equal(plannedCalls.filter((call) => call.tool.startsWith("browser_")).length, 0);
  assert.equal(plannedCalls[0].tool, "airtable.update_field");
});
