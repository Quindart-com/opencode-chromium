import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { AgentBrowserRuntime } from "../../src/core/runtime.js";
import { ArtifactStore } from "../../src/core/artifacts.js";

function fakeRuntime() {
  const store = new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-runtime-test-")) });
  const runtime = new AgentBrowserRuntime({ artifactStore: store });
  runtime.executed = [];
  runtime.selectProfile = async (session) => {
    session.profileId = "profile-1";
    return { profileId: "profile-1" };
  };
  runtime.ensureTab = async (session) => {
    session.activeTabId = 42;
    return 42;
  };
  runtime.executeStep = async (step) => {
    runtime.executed.push(step.action);
    if (step.action === "find") return { results: [{ nodeId: "node-1" }] };
    return { done: step.action };
  };
  runtime.settleStep = async () => null;
  runtime.invoke = async (name) => ({ ended: name === "browser_turn_end" });
  return runtime;
}

test("risky action chain pauses once before any browser action", async () => {
  const runtime = fakeRuntime();
  try {
    const request = {
      sessionId: "safety-test",
      steps: [{ id: "submit", action: "click", target: { query: "Submit order" } }],
      returnMode: "all",
    };
    const first = await runtime.run(request);
    assert.equal(first.status, "approval_required");
    assert.deepEqual(runtime.executed, []);

    const second = await runtime.run({ approvalToken: first.approvalToken });
    assert.equal(second.status, "completed");
    assert.deepEqual(runtime.executed, ["click"]);
  } finally {
    runtime.close();
  }
});

test("approval follow-up rejects retransmitted or changed action chains", async () => {
  const runtime = fakeRuntime();
  try {
    const first = await runtime.run({ sessionId: "bound", steps: [{ action: "press", key: "Enter" }] });
    const changed = await runtime.run({ sessionId: "bound", steps: [{ action: "press", key: "Escape" }], approvalToken: first.approvalToken });
    assert.equal(changed.status, "invalid_request");
    assert.deepEqual(runtime.executed, []);
  } finally {
    runtime.close();
  }
});

test("network body inspection is approval-gated without changing the default tool surface", async () => {
  const store = new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-network-approval-test-")) });
  const runtime = new AgentBrowserRuntime({
    artifactStore: store,
    operationFactory: async () => ({
      tool: {
        browser_network_inspect: {
          capabilityOnly: true,
          args: {
            tabId: z.number().int().positive(),
            includeBody: z.enum(["none", "request", "response", "both"]).default("none"),
          },
          async execute() { return JSON.stringify({ events: [] }); },
        },
      },
    }),
  });
  try {
    const result = await runtime.run({
      sessionId: "network-approval",
      steps: [{ action: "capability", capability: "network.inspect", input: { tabId: 42, includeBody: "response" } }],
    });
    assert.equal(result.status, "approval_required");
    assert.match(result.reasons.join(" "), /network body inspection/);
  } finally {
    runtime.close();
  }
});

test("chain validation happens before profile or tab side effects", async () => {
  const runtime = fakeRuntime();
  let selected = false;
  runtime.selectProfile = async () => { selected = true; };
  try {
    const result = await runtime.run({ sessionId: "preflight", steps: [{ action: "navigate" }] });
    assert.equal(result.status, "invalid_request");
    assert.equal(selected, false);
  } finally {
    runtime.close();
  }
});

test("settle without a resolvable target fails fast instead of timing out", async () => {
  const runtime = fakeRuntime();
  delete runtime.settleStep;
  let invoked = false;
  runtime.invoke = async () => { invoked = true; throw new Error("should not reach the browser"); };
  try {
    await assert.rejects(
      runtime.settleStep({ action: "navigate", settle: { condition: "contains", value: "Example Domain" } }, 42, new Map(), runtime.getSession("settle-target")),
      /settle condition "contains" requires a target selector/,
    );
    await assert.rejects(
      runtime.settleStep({ action: "navigate", settle: { condition: "exists" } }, 42, new Map(), runtime.getSession("settle-target")),
      /settle condition "exists" requires a target selector or nodeId/,
    );
    assert.equal(invoked, false);
  } finally {
    runtime.close();
  }
});

test("settle contains with a selector passes when the text matches", async () => {
  const runtime = fakeRuntime();
  delete runtime.settleStep;
  runtime.invoke = async (name) => {
    assert.equal(name, "browser_locator_text");
    return { text: "Example Domain heading text" };
  };
  try {
    const result = await runtime.settleStep(
      { action: "navigate", settle: { condition: "contains", target: { selector: "h1" }, value: "Example Domain" } },
      42,
      new Map(),
      runtime.getSession("settle-match"),
    );
    assert.deepEqual(result, { condition: "contains", settled: true });
  } finally {
    runtime.close();
  }
});

test("large accessibility observations include a useful inline preview", async () => {
  const runtime = fakeRuntime();
  const nodes = Array.from({ length: 1200 }, (_, index) => ({
    nodeId: `ax-${index}`,
    backendDOMNodeId: index + 1,
    ignored: false,
    role: { value: index % 2 ? "button" : "heading" },
    name: { value: `Useful page node ${index} ${"x".repeat(700)}` },
  }));
  runtime.getSession("large-ax").activeTabId = 42;
  runtime.invoke = async (name) => {
    if (name === "browser_snapshot") return { nodes };
    throw new Error(`Unexpected operation: ${name}`);
  };
  try {
    const result = await runtime.observe({ sessionId: "large-ax", mode: "raw-snapshot" });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.result.totalNodes, 1200);
    assert.ok(result.result.nodes.length > 0);
    assert.match(result.result.nodes[0].name, /Useful page node/);
    assert.ok(result.artifact?.uri);
    assert.ok(JSON.stringify(result).length <= 4096, "inline response should honor the default budget");
  } finally {
    runtime.close();
  }
});

test("inspect observations constrain legacy tree expansion before budgeting", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("inspect-limit").activeTabId = 42;
  let inspectArgs;
  runtime.invoke = async (name, args) => {
    if (name !== "browser_page_inspect") throw new Error(`Unexpected operation: ${name}`);
    inspectArgs = args;
    return { target: { name: "Settings" }, children: Array.from({ length: 100 }, (_, index) => ({ text: `child ${index} ${"y".repeat(500)}` })) };
  };
  try {
    const result = await runtime.observe({ sessionId: "inspect-limit", mode: "inspect", selector: "#settings" });
    assert.equal(inspectArgs.depth, 1);
    assert.equal(inspectArgs.maxChildren, 12);
    assert.equal(inspectArgs.maxText, 280);
    assert.equal(result.ok, true);
    assert.ok(result.result.target);
    assert.ok(JSON.stringify(result).length <= 4096);
  } finally {
    runtime.close();
  }
});

test("untargeted inspect uses a bounded active-surface root", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("inspect-root").activeTabId = 42;
  let selector;
  runtime.invoke = async (name, args) => {
    assert.equal(name, "browser_page_inspect");
    selector = args.selector;
    return { target: { name: "Page" } };
  };
  try {
    const result = await runtime.observe({ sessionId: "inspect-root", mode: "inspect", limit: 9999, maxChars: 999999 });
    assert.equal(result.ok, true);
    assert.match(selector, /dialog/);
    assert.ok(JSON.stringify(result).length <= 20000);
  } finally {
    runtime.close();
  }
});

test("postObserve is returned from the same run", async () => {
  const runtime = fakeRuntime();
  runtime.observeValue = async () => ({ results: [{ node_id: "saved", label: "Saved" }] });
  try {
    const result = await runtime.run({
      sessionId: "post-observe",
      steps: [{ action: "press", key: "Escape" }],
      postObserve: { mode: "search", query: "saved" },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.observation.results[0].node_id, "saved");
  } finally {
    runtime.close();
  }
});

test("clipboardWrite maps the common value field to the legacy text input", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  runtime.resolveTarget = async () => ({});
  let call;
  runtime.invoke = async (name, args) => { call = { name, args }; return { written: true }; };
  try {
    await runtime.executeStep({ action: "clipboardWrite", value: "copied safely" }, 42, new Map(), runtime.getSession("clipboard"));
    assert.equal(call.name, "browser_clipboard_write_text");
    assert.equal(call.args.text, "copied safely");
  } finally {
    runtime.close();
  }
});

test("read-only legacy operations retry once after a transient CDP failure", async () => {
  const runtime = fakeRuntime();
  let attempts = 0;
  runtime.legacyToolsPromise = Promise.resolve({
    browser_page_search: {
      args: { value: z.string() },
      async execute() {
        attempts += 1;
        if (attempts === 1) throw new Error("CDP timeout");
        return JSON.stringify({ results: [] });
      },
    },
  });
  delete runtime.invoke;
  try {
    const result = await runtime.invoke("browser_page_search", { value: "query" }, "read-retry");
    assert.deepEqual(result, { results: [] });
    assert.equal(attempts, 2);
  } finally {
    runtime.close();
  }
});

test("uncertain mutation failures attach compact recovery state without retrying", async () => {
  const runtime = fakeRuntime();
  let attempts = 0;
  runtime.executeStep = async () => {
    attempts += 1;
    throw new Error("CDP timeout after dispatch");
  };
  runtime.observeValue = async () => ({ target: { label: "Save" } });
  try {
    const result = await runtime.run({ sessionId: "uncertain", steps: [{ action: "click", target: { selector: "#commit-control" } }] });
    assert.equal(result.status, "partial");
    assert.equal(attempts, 1);
    assert.equal(result.results[0].error.uncertain, true);
    assert.equal(result.results[0].observation.target.label, "Save");
  } finally {
    runtime.close();
  }
});

test("stale target with a selector is re-resolved once", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  let resolutions = 0;
  let clicks = 0;
  runtime.resolveTarget = async () => {
    resolutions += 1;
    return resolutions === 1 ? { nodeId: "stale", selector: "#save" } : { selector: "#save" };
  };
  runtime.clickTarget = async () => {
    clicks += 1;
    if (clicks === 1) throw new Error("Element is detached");
    return { clicked: true };
  };
  try {
    const result = await runtime.executeStep({ action: "click", target: { nodeId: "stale", selector: "#save" } }, 42, new Map(), runtime.getSession("stale"));
    assert.equal(result.clicked, true);
    assert.equal(resolutions, 2);
    assert.equal(clicks, 2);
  } finally {
    runtime.close();
  }
});

test("opening a named profile returns its tabs immediately", async () => {
  const runtime = fakeRuntime();
  runtime.connectedProfiles = async () => [{ profileId: "work-id", profileLabel: "Work" }];
  runtime.selectProfile = async (session, requested) => {
    assert.equal(requested, "Work");
    session.profileId = "work-id";
    return { profileId: "work-id" };
  };
  runtime.invoke = async (name, args) => {
    assert.equal(name, "browser_list_tabs");
    assert.equal(args.scope, "user");
    return { tabs: [{ id: 9, title: "Dashboard" }] };
  };
  try {
    const result = await runtime.session({ sessionId: "named-open", action: "open", profile: "Work", scope: "user" });
    assert.equal(result.ok, true);
    assert.equal(result.result.tabs[0].id, 9);
  } finally {
    runtime.close();
  }
});

test("hover resolves a target and dispatches the hover operation without clicking", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  runtime.resolveTarget = async () => ({ selector: "#menu" });
  let call;
  runtime.invoke = async (name, args) => { call = { name, args }; return { hovered: true }; };
  try {
    const result = await runtime.executeStep({ action: "hover", target: { selector: "#menu" } }, 42, new Map(), runtime.getSession("hover"));
    assert.equal(result.hovered, true);
    assert.equal(call.name, "browser_hover");
    assert.equal(call.args.selector, "#menu");
  } finally {
    runtime.close();
  }
});

test("hover by coordinates dispatches viewport points", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  runtime.resolveTarget = async () => ({ x: 10, y: 20 });
  let call;
  runtime.invoke = async (name, args) => { call = { name, args }; return { hovered: true }; };
  try {
    await runtime.executeStep({ action: "hover", target: { x: 10, y: 20 } }, 42, new Map(), runtime.getSession("hover-coords"));
    assert.equal(call.name, "browser_hover");
    assert.equal(call.args.x, 10);
    assert.equal(call.args.y, 20);
  } finally {
    runtime.close();
  }
});

test("hover by nodeId dispatches the DOM node hover operation", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  runtime.resolveTarget = async () => ({ nodeId: "node-7" });
  let call;
  runtime.invoke = async (name, args) => { call = { name, args }; return { hovered: true }; };
  try {
    await runtime.executeStep({ action: "hover", target: { nodeId: "node-7" } }, 42, new Map(), runtime.getSession("hover-node"));
    assert.equal(call.name, "browser_hover");
    assert.equal(call.args.nodeId, "node-7");
  } finally {
    runtime.close();
  }
});

test("handleDialog dispatches the dialog operation with prompt text", async () => {
  const runtime = fakeRuntime();
  delete runtime.executeStep;
  runtime.resolveTarget = async () => ({});
  let call;
  runtime.invoke = async (name, args) => { call = { name, args }; return { handled: true }; };
  try {
    const result = await runtime.executeStep(
      { action: "handleDialog", value: "accept", promptText: "confirmed" },
      42,
      new Map(),
      runtime.getSession("dialog"),
    );
    assert.equal(result.handled, true);
    assert.equal(call.name, "browser_handle_dialog");
    assert.equal(call.args.value, "accept");
    assert.equal(call.args.promptText, "confirmed");
  } finally {
    runtime.close();
  }
});

test("accepting a dialog pauses the chain for approval", async () => {
  const runtime = fakeRuntime();
  try {
    const first = await runtime.run({ sessionId: "dialog-approval", steps: [{ action: "handleDialog", value: "accept" }] });
    assert.equal(first.status, "approval_required");
    assert.match(first.reasons.join(" "), /dialog accept/);
    assert.deepEqual(runtime.executed, []);
  } finally {
    runtime.close();
  }
});

test("events observation includes a dialogs bucket", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("events-dialogs").activeTabId = 42;
  runtime.invoke = async (name, args) => {
    if (name === "browser_console_logs") return { events: [] };
    if (name === "browser_network_events") return { events: [] };
    if (name === "browser_dialog_events") return { events: [{ event: "opened", type: "confirm", message: "Delete item?" }] };
    throw new Error(`Unexpected operation: ${name}`);
  };
  try {
    const result = await runtime.observe({ sessionId: "events-dialogs", mode: "events" });
    assert.equal(result.ok, true);
    assert.equal(result.result.dialogs.events[0].type, "confirm");
  } finally {
    runtime.close();
  }
});

test("url policy is attached to operation invocation context", async () => {
  const runtime = new AgentBrowserRuntime({
    urlPolicyConfig: { blockedOrigins: ["https://blocked.example"] },
    operationFactory: async () => ({
      tool: {
        browser_navigate: {
          args: { url: z.string() },
          async execute(args, context) {
            return JSON.stringify({ contextHasPolicy: Boolean(context?.urlPolicy), blocked: context?.urlPolicy?.evaluate(args.url) });
          },
        },
        browser_turn_end: { args: {}, async execute() { return "{}"; } },
      },
    }),
  });
  runtime.selectProfile = async (session) => { session.profileId = "policy-profile"; return { profileId: "policy-profile" }; };
  runtime.ensureTab = async (session) => { session.activeTabId = 1; return 1; };
  try {
    const result = await runtime.run({ sessionId: "policy-context", steps: [{ action: "navigate", url: "https://blocked.example/x" }] });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].result.contextHasPolicy, true);
    assert.equal(result.results[0].result.blocked.allowed, false);
    assert.equal(result.results[0].result.blocked.code, "URL_POLICY_BLOCKED");
  } finally {
    runtime.close();
  }
});

test("screenshot observations forward format and quality to the capture operation", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("shot-format").activeTabId = 42;
  let captureArgs;
  runtime.invoke = async (name, args) => {
    if (name !== "browser_screenshot") throw new Error(`Unexpected operation: ${name}`);
    captureArgs = args;
    return { mimeType: "image/webp", base64: Buffer.from("fake").toString("base64") };
  };
  try {
    const result = await runtime.observe({ sessionId: "shot-format", mode: "screenshot", format: "webp", quality: 80 });
    assert.equal(result.ok, true);
    assert.equal(captureArgs.format, "webp");
    assert.equal(captureArgs.quality, 80);
    assert.equal(result.result.screenshot.mimeType, "image/webp");
  } finally {
    runtime.close();
  }
});

test("session configure applies an environment and reports it on open", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("env-session").activeTabId = 7;
  let configureCall;
  runtime.invoke = async (name, args) => {
    if (name === "browser_configure") { configureCall = args; return { configured: true }; }
    if (name === "browser_list_tabs") return { tabs: [] };
    throw new Error(`Unexpected operation: ${name}`);
  };
  try {
    const environment = { viewport: { width: 390, height: 844, mobile: true }, colorScheme: "dark", network: "slow-4g" };
    const configured = await runtime.session({ sessionId: "env-session", action: "configure", tabId: 7, environment });
    assert.equal(configured.ok, true);
    assert.equal(configured.result.tabId, 7);
    assert.deepEqual(configured.result.environment.environment ?? configureCall.environment, environment);
    assert.equal(configureCall.environment.viewport.width, 390);

    const opened = await runtime.session({ sessionId: "env-session", action: "open" });
    assert.equal(opened.ok, true);
    assert.equal(opened.environment.colorScheme, "dark");
  } finally {
    runtime.close();
  }
});

test("session configure reset clears the tracked environment", async () => {
  const runtime = fakeRuntime();
  runtime.getSession("env-reset").activeTabId = 7;
  let resetCall;
  runtime.invoke = async (name, args) => {
    if (name === "browser_configure") { resetCall = args; return { configured: true }; }
    throw new Error(`Unexpected operation: ${name}`);
  };
  try {
    const result = await runtime.session({ sessionId: "env-reset", action: "configure", tabId: 7, environment: { reset: true } });
    assert.equal(result.ok, true);
    assert.equal(resetCall.environment.reset, true);
    assert.deepEqual(result.result.environment, {});
  } finally {
    runtime.close();
  }
});

test("finalize clears applied environment overrides unless retained", async () => {
  const runtime = fakeRuntime();
  const session = runtime.getSession("env-finalize");
  session.activeTabId = 7;
  session.environment = { colorScheme: "dark" };
  let cleared = false;
  runtime.invoke = async (name, args) => {
    if (name === "browser_configure") { cleared = args.environment?.reset === true; return { configured: true }; }
    if (name === "browser_finalize") return { profiles: {} };
    throw new Error(`Unexpected operation: ${name}`);
  };
  try {
    const result = await runtime.finalize({ sessionId: "env-finalize" });
    assert.equal(result.ok, true);
    assert.equal(cleared, true);
  } finally {
    runtime.close();
  }
});
