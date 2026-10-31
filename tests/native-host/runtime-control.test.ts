import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { createController } from "../../src/control/controller.ts";
import { activateRelease,rollbackRelease } from "../../src/control/activation.ts";
import { browserCompatibilityStatus,browserContractFromHello,selectBrowserRelease } from "../../src/control/browser-compatibility.ts";
import { createParticipant } from "../../src/control/leases.ts";
import { parseRuntimeActivation } from "../../src/control/state.ts";
import { launcherPlan } from "../../src/cli/runtime-link.ts";
import { supervisorFiles } from "../../src/management/supervisor.ts";
import { CONTROL_METHODS } from "../../src/shared/control-protocol.ts";
import { desiredRuntime } from "../../src/shared/runtime-config.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-"));
  const oldRoot = path.join(dir, "releases/1.10.1/node_modules/opencode-chromium");
  const nextRoot = path.join(dir, "releases/1.10.2/node_modules/opencode-chromium");
  for (const [root,version] of [[oldRoot,"1.10.1"],[nextRoot,"1.10.2"]]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium",version,toolContractVersion: 1 }));
  }
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ root: oldRoot,version: "1.10.1",channel: "production",autoUpdate: true,
    stagedRelease: { root: nextRoot,version: "1.10.2" } }));
  fs.writeFileSync(path.join(dir, "controller.json"), JSON.stringify({ protocolVersion: 2,controllerVersion: "1.11.0",globalCliVersion: "1.10.2",installedAt: new Date().toISOString() }));
  return { dir,oldRoot,nextRoot,cleanup: () => fs.rmSync(dir, { recursive: true,force: true }) };
}

test("legacy selected and staged state migrates without promoting an unvalidated staged release", () => {
  const f = fixture();
  try {
    const state = parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")));
    assert.equal(state.schemaVersion, 2);
    assert.equal(desiredRuntime(state).version, "1.10.1");
    assert.equal(state.stagedRelease?.version, "1.10.2");
  } finally { f.cleanup(); }
});

test("control capabilities are negotiated independently of worker versions", async () => {
  const f = fixture();
  try {
    const controller = createController({ dir: f.dir });
    const capabilities = await controller.handle("control.capabilities") as { protocolVersion: number; methods: readonly string[]; activation: string };
    assert.equal(capabilities.protocolVersion, 2);
    assert.deepEqual(capabilities.methods, CONTROL_METHODS);
    assert.equal(capabilities.activation, "blue-green");
  } finally { f.cleanup(); }
});

test("status reports extension, global CLI, controller, desired runtime, and pinned workers separately", () => {
  const f = fixture();
  const participant = createParticipant(f.dir, "supervisor", "1.10.1", f.oldRoot, { contractVersion: 1,harness: "codex",sessions: ["active"] });
  try {
    const status = createController({ dir: f.dir }).status({ extensionVersion: "1.10.2" });
    const components = new Map(status.components.map(component => [component.component, component]));
    assert.equal(components.get("extension")?.version, "1.10.2");
    assert.equal(components.get("global-cli")?.version, "1.10.2");
    assert.equal(components.get("controller")?.version, "1.11.0");
    assert.equal(components.get("desired-runtime")?.version, "1.10.1");
    assert.equal(status.components.find(component => component.component === "active-worker")?.state, "current");
    assert.doesNotMatch(status.reason ?? "", /old cli/i);
  } finally { participant.close(); f.cleanup(); }
});

test("blue-green activation routes new work to desired and keeps a busy lease pinned", async () => {
  const f = fixture();
  const participant = createParticipant(f.dir, "supervisor", "1.10.1", f.oldRoot, { contractVersion: 1,sessions: ["active"],inFlight: 1 });
  try {
    assert.equal(await activateRelease(f.dir, { root: f.nextRoot,version: "1.10.2",contractVersion: 1 }), true);
    const activation = parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")));
    assert.equal(desiredRuntime(activation).version, "1.10.2");
    assert.equal(activation.fallback?.version, "1.10.1");
    assert.equal(participant.state.version, "1.10.1");
    assert.equal((await rollbackRelease(f.dir)).code, "rollback_started");
    assert.equal(desiredRuntime(parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")))).version, "1.10.1");
  } finally { participant.close(); f.cleanup(); }
});

test("all configured launchers target the fixed controller or desired runtime", () => {
  assert.deepEqual(launcherPlan("host"), { selection: "controller",entry: "controller/2/control/browser-broker.js" });
  assert.deepEqual(launcherPlan("mcp"), { selection: "controller",entry: "controller/2/control/mcp-supervisor.js" });
  assert.deepEqual(launcherPlan("plugin"), { selection: "desired",entry: "dist/adapters/opencode/index.js" });
});

test("old Web Store extensions keep a compatible worker while newer extensions adopt desired", () => {
  const f = fixture();
  try {
    const desired = { root: f.nextRoot,version: "2.0.0",contractVersion: 2 };
    const fallback = { root: f.oldRoot,version: "1.11.0",contractVersion: 1 };
    fs.writeFileSync(path.join(desired.root, "package.json"), JSON.stringify({ name: "opencode-chromium",version: desired.version,
      browserContractVersion: 2,supportedBrowserContractVersions: [2] }));
    fs.writeFileSync(path.join(fallback.root, "package.json"), JSON.stringify({ name: "opencode-chromium",version: fallback.version,
      browserContractVersion: 1,supportedBrowserContractVersions: [1] }));
    const activation = { root: desired.root,version: desired.version,desired,fallback };
    assert.equal(browserContractFromHello({}), 1, "pre-contract extensions negotiate as browser contract 1");
    assert.equal(selectBrowserRelease(activation, 1)?.root, fallback.root);
    assert.equal(selectBrowserRelease(activation, 2)?.root, desired.root);
    assert.deepEqual(browserCompatibilityStatus(activation, fallback, 1), { compatible: true,extensionContractVersion: 1,
      runtimeContractVersions: [1],runtimeVersion: "1.11.0",selection: "fallback" });
    fs.writeFileSync(path.join(desired.root, "package.json"), JSON.stringify({ name: "opencode-chromium",version: desired.version,
      browserContractVersion: 2,supportedBrowserContractVersions: [1,2] }));
    assert.equal(selectBrowserRelease(activation, 1)?.root, desired.root, "bridge releases adopt immediately even before store review completes");
  } finally { f.cleanup(); }
});

test("the installed controller is a complete importable module graph", async () => {
  const f = fixture();
  try {
    for (const file of supervisorFiles(f.dir)) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      fs.writeFileSync(file.filePath, file.after!);
    }
    const installed = await import(`${pathToFileURL(path.join(f.dir, "controller", "2", "control", "controller.js")).href}?fixture=${Date.now()}`);
    assert.equal(typeof installed.createController, "function");
  } finally { f.cleanup(); }
});
