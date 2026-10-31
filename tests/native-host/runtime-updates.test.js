import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntimeUpdater, createIdleUpdateCheck, releaseVersion,validateRelease } from "../../src/control/update.ts";
import { rollbackRelease } from "../../src/control/activation.ts";
import { createParticipant } from "../../src/control/leases.ts";
import { desiredRuntime } from "../../src/shared/runtime-config.ts";
import { resolveRuntime, activeRuntimeLeases, withRuntimeLock } from "../../src/control/state.ts";
import { RpcRelay } from "../../native-host/src/rpc-relay.ts";
import { FrameDecoder } from "../../src/shared/node-framing.ts";
import { installPublishedUpdate,publishedVersion } from "../../src/management/manual-update.ts";

function release(root, version) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium", version, runtimeControllerProtocol: 2,
    toolContractVersion: Number(version.split(".")[0]) >= 2 ? 2 : 1,browserContractVersion: 1,supportedBrowserContractVersions: [1] }));
  const build = path.join(root, "dist/build-manifest.json"); fs.mkdirSync(path.dirname(build), { recursive: true });
  fs.writeFileSync(build, JSON.stringify({ name: "opencode-chromium", version, sha256: "a".repeat(64) }));
  for (const file of ["dist/cli/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith(".json") ? JSON.stringify({ version }) : "// fixture\n");
  }
  for (const file of ["browser-broker.js", "browser-compatibility.js", "controller.js", "jobs.js", "mcp-supervisor.js", "mcp-worker.js", "state.js", "leases.js", "update.js"]) {
    const target = path.join(root, "dist/control", file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "// fixture\n");
  }
}
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-updates-")), root = path.join(dir, "initial");
  release(root, "1.9.2");
  const manifest = path.join(dir, "runtime.json");
  fs.writeFileSync(manifest, JSON.stringify({ root, version: "1.9.2", channel: "production", autoUpdate: true, preserved: "yes" }));
  let installs = 0;
  const updater = createRuntimeUpdater({ dir, install: async (stage, version) => { installs++; release(path.join(stage, "node_modules/opencode-chromium"), version); }, ...options });
  return { dir, root, manifest, updater, installs: () => installs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test("legacy state migrates to schema v2 and a validated release becomes desired without deleting the fallback", async () => {
  const f = fixture();
  try {
    await f.updater.tick("1.9.3");
    const activation = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(activation.schemaVersion, 2);
    assert.equal(desiredRuntime(activation).version, "1.9.3");
    assert.equal(activation.fallback.version, "1.9.2");
    assert.equal(activation.preserved, "yes");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "package.json"))).version, "1.9.2");
    assert.equal(f.updater.status().state, "draining");
  } finally { f.cleanup(); }
});
test("busy existing connections remain pinned while new connections see the desired release", async () => {
  const f = fixture();
  const lease = createParticipant(f.dir, "supervisor", "1.9.2", f.root, { contractVersion: 1, sessions: ["busy"], inFlight: 1, harness: "codex" });
  try {
    await f.updater.tick("1.9.3");
    const activation = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(desiredRuntime(activation).version, "1.9.3");
    assert.equal(lease.state.version, "1.9.2");
    assert.equal(f.updater.status().state, "draining");
    assert.equal(f.updater.status().blockerCount, 1);
  } finally { lease.close(); f.cleanup(); }
});

test("major releases require one explicit approval before blue-green activation", async () => {
  const f = fixture();
  try {
    await f.updater.tick("2.0.0");
    assert.equal(f.updater.status().state, "approval_required");
    assert.equal(desiredRuntime(JSON.parse(fs.readFileSync(f.manifest))).version, "1.9.2");
    await f.updater.tick("2.0.0", { approvedMajor: true });
    const activation = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(desiredRuntime(activation).version, "2.0.0");
    assert.equal(activation.approvedMajor, 2);
  } finally { f.cleanup(); }
});

test("release validation preserves one Web Store compatibility generation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-browser-contract-"));
  try {
    release(dir, "2.0.0");
    validateRelease(dir, "2.0.0");
    const packageFile = path.join(dir, "package.json"), pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    fs.writeFileSync(packageFile, JSON.stringify({ ...pkg,browserContractVersion: 2,supportedBrowserContractVersions: [2] }));
    assert.throws(() => validateRelease(dir, "2.0.0"), /browser compatibility contract/);
    fs.writeFileSync(packageFile, JSON.stringify({ ...pkg,browserContractVersion: 2,supportedBrowserContractVersions: [1,2] }));
    validateRelease(dir, "2.0.0");
    fs.rmSync(path.join(dir, "dist/control/browser-compatibility.js"));
    assert.throws(() => validateRelease(dir, "2.0.0"), /Incomplete runtime controller/);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
});

test("rollback assigns fallback as desired and drains through the same path", async () => {
  const f = fixture();
  try {
    await f.updater.tick("1.9.3");
    const result = await rollbackRelease(f.dir);
    assert.equal(result.code, "rollback_started");
    const activation = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(desiredRuntime(activation).version, "1.9.2");
    assert.equal(activation.fallback.version, "1.9.3");
  } finally { f.cleanup(); }
});

test("concurrent updaters install once and corrupt downloads never change desired", async () => {
  const f = fixture(); let installs = 0;
  try {
    const install = async (stage, version) => { installs++; await new Promise(resolve => setTimeout(resolve, 30)); release(path.join(stage, "node_modules/opencode-chromium"), version); };
    await Promise.all([createRuntimeUpdater({ dir: f.dir, install }).tick("1.9.3"), createRuntimeUpdater({ dir: f.dir, install }).tick("1.9.3")]);
    assert.equal(installs, 1);
    const broken = createRuntimeUpdater({ dir: f.dir, install: async () => { throw new Error("registry unavailable"); } });
    await broken.tick("1.9.4");
    assert.equal(broken.status().state, "retry");
    assert.equal(desiredRuntime(JSON.parse(fs.readFileSync(f.manifest))).version, "1.9.3");
    assert.ok(!JSON.stringify(broken.status()).includes("registry unavailable"));
  } finally { f.cleanup(); }
});

test("manual installation accepts only a stable version of the official package", async () => {
  await assert.rejects(publishedVersion(async () => ({ name: "another-package", version: "1.9.3" })));
  await assert.rejects(publishedVersion(async () => ({ name: "opencode-chromium", version: "1.9.4-dev.1" })));
  assert.equal(await publishedVersion(async () => ({ name: "opencode-chromium", version: "1.9.4" })), "1.9.4");
});
test("startup takes a lease under the activation lock; exited-process leases are reaped", async () => {
  const f = fixture();
  try {
    const module = pathToFileURL(path.resolve("src/control/state.ts")).href;
    const child = promisify(execFile);
    await withRuntimeLock(f.dir, async () => {
      const marker = path.join(f.dir, "child-started");
      const pending = child(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs'; import {resolveRuntime} from ${JSON.stringify(module)}; fs.writeFileSync(${JSON.stringify(marker)},'ready'); await resolveRuntime(${JSON.stringify(f.dir)});`], { windowsHide: true });
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(marker)) { if (Date.now() >= deadline) throw new Error("Child did not start"); await new Promise(resolve => setTimeout(resolve, 20)); }
      // The child cannot create its lease until the parent releases the gate.
      assert.equal(activeRuntimeLeases(f.dir), 0);
      f.pending = pending;
    });
    await f.pending; assert.equal(activeRuntimeLeases(f.dir), 0);
  } finally { f.cleanup(); }
});
test("agent clients cannot configure runtime updates and self-checks count all real connections", async () => {
  let called = false; const messages = [];
  const relay = new RpcRelay({ state: {}, extensionWriter: async () => {}, localHandler: () => { called = true; } });
  const socket = new PassThrough(), decoder = new FrameDecoder({ onMessage: value => messages.push(value) });
  socket.on("data", chunk => decoder.push(chunk)); relay.addClient(socket);
  assert.equal(relay.activity(false).clients, 1); assert.equal(relay.activity().clients, 0);
  await relay.handleClientMessage(socket, { jsonrpc: "2.0", id: 1, method: "runtime.updateConfigure", params: { enabled: true } });
  assert.equal(called, false); assert.equal(messages[0].error.code, -32000);
  socket.destroy();
});
test("host retirement waits for quiet time and rechecks new activity after the extension replies", async () => {
  let clock = 0, active = false, panelIdle = false, retirements = 0, ticks = 0;
  const updater = { status: () => ({ enabled: true, installedVersion: "1.9.3" }), tick: async () => { ticks++; } };
  const check = createIdleUpdateCheck({ updater, nativeVersion: "1.9.2", target: () => "1.9.3", active: () => active,
    canReconnect: async () => { if (panelIdle) active = true; return panelIdle; }, retire: () => { retirements++; }, now: () => clock });
  await check(); assert.equal(ticks, 1);
  clock = 61000; active = true; await check(); active = false;
  clock = 90000; await check(); assert.equal(ticks, 3);
  clock = 122000; await check(); assert.equal(ticks, 4); assert.equal(retirements, 0);
  panelIdle = true; await check(); assert.equal(retirements, 0);
  const ready = createIdleUpdateCheck({ updater, nativeVersion: "1.9.2", target: () => "1.9.3", active: () => false,
    canReconnect: async () => true, retire: () => { retirements++; }, now: () => clock });
  clock += 61000; await ready(); assert.equal(retirements, 1);
});
test("idle probes never create an unknown-client version warning", async () => {
  const broadcasts = [], socket = new PassThrough();
  const relay = new RpcRelay({ state: {}, extensionWriter: async value => broadcasts.push(value), localHandler: async () => ({ clients: 0, pending: 0 }) });
  relay.addClient(socket);
  await relay.handleClientMessage(socket, { jsonrpc: "2.0", id: 1, method: "runtime.activity", params: {} });
  assert.equal(broadcasts.length, 0); socket.destroy();
});

test("routine no-update ticks do not scan participant files; explicit status still reports them", async () => {
  const f = fixture();
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = function (directory, ...args) {
    if (String(directory) === path.join(f.dir, "participants")) scans++;
    return original.call(this, directory, ...args);
  };
  try {
    fs.mkdirSync(path.join(f.dir, "participants"));
    const check = createIdleUpdateCheck({ updater: f.updater, nativeVersion: "1.9.2", target: () => "1.9.2", active: () => false,
      canReconnect: async () => assert.fail("Matching versions must not reconnect"), retire: () => assert.fail("Must not retire"), quietMs: 0 });
    f.updater.schedule("1.9.2");
    await f.updater.tick("1.9.2"); await check(); await check();
    assert.equal(scans, 0);
    assert.equal(f.updater.status().blockerCount, 0);
    assert.equal(scans, 1);
  } finally { fs.readdirSync = original; f.cleanup(); }
});
