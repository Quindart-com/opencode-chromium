import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeUpdater, createIdleUpdateCheck, releaseVersion } from "../../native-host/src/runtime-updates.ts";
import { resolveRuntime, activeRuntimeLeases, withRuntimeLock } from "../../native-host/src/runtime-lifecycle.ts";
import { RpcRelay } from "../../native-host/src/rpc-relay.ts";
import { FrameDecoder } from "../../native-host/src/framing.ts";
import { installPublishedUpdate,publishedVersion } from "../../src/management/manual-update.ts";

function release(root, version) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium", version }));
  for (const file of ["dist/cli/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith(".json") ? JSON.stringify({ version }) : "// fixture\n");
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
test("idle update validates a side-by-side release and preserves the original install and preferences", async () => {
  const f = fixture();
  try {
    await f.updater.tick("1.9.3");
    const active = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(active.version, "1.9.3"); assert.equal(active.preserved, "yes"); assert.notEqual(active.root, f.root);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "package.json"))).version, "1.9.2");
    assert.equal(f.updater.status().state, "ready");
    await f.updater.tick("1.9.2"); await f.updater.tick("1.9.3"); assert.equal(f.installs(), 1);
  } finally { f.cleanup(); }
});
test("live leases and busy profiles allow staging but defer activation", async () => {
  const f = fixture();
  try {
    await resolveRuntime(f.dir); await f.updater.tick("1.9.3");
    assert.equal(f.updater.status().state, "waiting"); assert.equal(f.installs(), 1);
    assert.equal(f.updater.status().stagedVersion, "1.9.3");
    fs.rmSync(path.join(f.dir, "leases"), { recursive: true });
    const second = createRuntimeUpdater({ dir: f.dir, busy: async () => true, install: async () => assert.fail("Busy browser must not install") });
    await second.tick("1.9.3"); assert.equal(second.status().state, "waiting");
  } finally { f.cleanup(); }
});

test("a manual update stages while automatic updates are off, preserves the preference and waits for active agents", async () => {
  const f = fixture({ busy: async () => true }), globals = [];
  try {
    await f.updater.configure(false);
    const result = await installPublishedUpdate(f.dir, { latest: async () => "1.9.3", updater: f.updater, globalInstall: async version => { globals.push(version); }, refreshSkills: () => 0, refreshMarketplace: async () => ({ status: "not_configured" }) });
    assert.equal(result.code, "update_waiting"); assert.deepEqual(globals, ["1.9.3"]);
    const activation = JSON.parse(fs.readFileSync(f.manifest));
    assert.equal(activation.autoUpdate, false); assert.equal(activation.root, f.root); assert.equal(activation.stagedRelease.version, "1.9.3");
    assert.equal(f.installs(), 1);
  } finally { f.cleanup(); }
});

test("manual installation accepts only a stable version of the official package", async () => {
  await assert.rejects(publishedVersion(async () => ({ name: "another-package", version: "1.9.3" })));
  await assert.rejects(publishedVersion(async () => ({ name: "opencode-chromium", version: "1.9.4-dev.1" })));
  assert.equal(await publishedVersion(async () => ({ name: "opencode-chromium", version: "1.9.4" })), "1.9.4");
});
test("a new agent starting during download defers activation, then reuses the validated download", async () => {
  const f = fixture(); let installs = 0;
  try {
    const updater = createRuntimeUpdater({ dir: f.dir, install: async (stage, version) => {
      installs++; release(path.join(stage, "node_modules/opencode-chromium"), version); await resolveRuntime(f.dir);
    } });
    await updater.tick("1.9.3"); assert.equal(updater.status().state, "waiting");
    assert.equal(JSON.parse(fs.readFileSync(f.manifest)).root, f.root);
    fs.rmSync(path.join(f.dir, "leases"), { recursive: true });
    await updater.tick("1.9.3"); assert.equal(updater.status().state, "ready"); assert.equal(installs, 1);
  } finally { f.cleanup(); }
});
test("failed or incomplete downloads keep the old pointer, clean staging, and back off", async () => {
  let clock = 100, installs = 0;
  const f = fixture({ now: () => clock, install: async () => { installs++; throw new Error("private registry details"); } });
  try {
    await f.updater.tick("1.9.3"); await f.updater.tick("1.9.3");
    assert.equal(installs, 1); assert.equal(JSON.parse(fs.readFileSync(f.manifest)).root, f.root);
    assert.equal(f.updater.status().state, "retry"); assert.ok(!JSON.stringify(f.updater.status()).includes("private registry"));
    assert.ok(!fs.readdirSync(f.dir).some(name => name.startsWith("update-stage-")));
    clock += 6 * 3600000; await f.updater.tick("1.9.3"); assert.equal(installs, 2);
  } finally { f.cleanup(); }
});
test("opting out during a download prevents activation; development checkouts remain manual", async () => {
  const f = fixture();
  try {
    const updater = createRuntimeUpdater({ dir: f.dir, install: async (stage, version) => {
      release(path.join(stage, "node_modules/opencode-chromium"), version); await updater.configure(false);
    } });
    await updater.tick("1.9.3"); assert.equal(updater.status().enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(f.manifest)).root, f.root);
    await updater.configure(true); fs.mkdirSync(path.join(f.root, "src"));
    await updater.tick("1.9.3"); assert.equal(updater.status().state, "manual");
  } finally { f.cleanup(); }
});
test("invalid versions, downgrades, disabled updates and simultaneous ticks do not install twice", async () => {
  const f = fixture();
  try {
    for (const version of ["latest", "1.9.3;bad", "../1.9.3", "1.9.3-beta", "01.9.3"]) { assert.equal(releaseVersion(version), false); await f.updater.tick(version); }
    await f.updater.configure(false); await f.updater.tick("1.9.3"); assert.equal(f.installs(), 0);
    await f.updater.configure(true); await Promise.all([f.updater.tick("1.9.3"), f.updater.tick("1.9.3")]); assert.equal(f.installs(), 1);
  } finally { f.cleanup(); }
});
test("two profile hosts share the worker lock and a mismatched package cannot activate", async () => {
  const f = fixture(); let installs = 0;
  try {
    const install = async (stage, version) => { installs++; await new Promise(resolve => setTimeout(resolve, 30)); release(path.join(stage, "node_modules/opencode-chromium"), version); };
    const first = createRuntimeUpdater({ dir: f.dir, install }), second = createRuntimeUpdater({ dir: f.dir, install });
    await Promise.all([first.tick("1.9.3"), second.tick("1.9.3")]); assert.equal(installs, 1);
    const invalid = createRuntimeUpdater({ dir: f.dir, install: async (stage) => release(path.join(stage, "node_modules/opencode-chromium"), "0.0.1") });
    await invalid.tick("1.9.4"); assert.equal(invalid.status().state, "retry"); assert.equal(JSON.parse(fs.readFileSync(f.manifest)).version, "1.9.3");
  } finally { f.cleanup(); }
});
test("startup takes a lease under the activation lock; exited-process leases are reaped", async () => {
  const f = fixture();
  try {
    const module = pathToFileURL(path.resolve("native-host/src/runtime-lifecycle.ts")).href;
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
