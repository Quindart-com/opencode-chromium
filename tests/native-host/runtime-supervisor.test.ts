import { test,expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeLaunchers } from "../../src/cli/runtime-link.ts";
import { createRuntimeUpdater } from "../../native-host/src/runtime-updates.ts";
import { activateRelease } from "../../native-host/src/runtime-activation.ts";
import { atomicJson,createParticipant,participants,readJournal,sleep } from "../../native-host/src/runtime-participants.ts";
import { lines } from "../../native-host/src/runtime-worker.ts";
import { FrameDecoder,writeFrame } from "../../native-host/src/framing.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-supervisor-"));
  const root = release("1.0.0");
  atomicJson(path.join(dir, "runtime.json"), { root, version: "1.0.0", autoUpdate: true });
  writeLaunchers(root, dir);
  function release(version: string, schema = "object") {
    const root = path.join(dir, version); fs.mkdirSync(root, { recursive: true });
    atomicJson(path.join(root, "package.json"), { name: "opencode-chromium", version, type: "module", runtimeSupervisorProtocol: 1, testSchema: schema });
    for (const file of ["dist/adapters/mcp/server.js", "dist/cli/index.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), file.endsWith(".json") ? JSON.stringify({ version }) : "// fixture\n");
    }
    fs.copyFileSync(path.join(process.cwd(), "tests/fixtures/supervised-worker.mjs"), path.join(root, "dist/adapters/mcp/server.js"));
    for (const file of ["runtime-coordinator.js", "runtime-supervisor.js", "runtime-worker.js", "runtime-participants.js", "runtime-activation.js", "runtime-lifecycle.js"]) fs.writeFileSync(path.join(root, "native-host/dist", file), "// fixture\n");
    return root;
  }
  const children: ReturnType<typeof spawn>[] = [];
  const logs: Array<() => string> = [];
  function client(extraEnv: NodeJS.ProcessEnv = {}) {
    const child = spawn("node", [path.join(dir, "mcp.mjs")], { windowsHide: true,
      env: { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: dir, TEST_PARTICIPANTS_MODULE: path.join(process.cwd(), "native-host/dist/runtime-participants.js"), TEST_MUTATION_LOG: path.join(dir, "mutations"), ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    let id = 0, stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    logs.push(() => stderr);
    const decode = lines(message => { const entry = pending.get(Number(message.id)); if (entry) { pending.delete(Number(message.id)); clearTimeout(entry.timer); entry.resolve(message); } });
    child.stdout?.on("data", decode);
    child.on("exit", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(stderr || "Supervisor exited")); } });
    const call = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No response: ${method}; ${stderr}`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
    return { call, child, logs: () => stderr, initialize: () => call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }), tool: (args: Record<string, unknown> = {}) => call("tools/call", { name: "browser_session", arguments: args }) };
  }
  return { dir, root, release, client, logs: () => logs.map(read => read()).join("\n"), async cleanup() {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const exited = once(child, "exit"); child.stdin?.end(); await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}
async function idleParticipants(dir: string) {
  const deadline = Date.now() + 5000;
  while (participants(dir).some(row => row.inFlight > 0)) {
    if (Date.now() > deadline) throw new Error("Participants did not drain");
    await sleep(5);
  }
}

test("two harness connections stay open: stage during work, switch only after both sessions finish", async () => {
  const f = fixture();
  try {
    const a = f.client(), b = f.client(); await Promise.all([a.initialize(), b.initialize()]);
    await a.tool({ action: "open", sessionId: "agent-a" }); await b.tool({ action: "open", sessionId: "agent-b" });
    const updater = createRuntimeUpdater({ dir: f.dir, install: async (stage, version) => {
      fs.cpSync(f.release(version), path.join(stage, "node_modules/opencode-chromium"), { recursive: true });
    } });
    await updater.tick("1.0.1"); expect(updater.status().state).toBe("waiting"); expect(updater.status().stagedVersion).toBe("1.0.1");
    await a.tool({ action: "finish", sessionId: "agent-a" }); await updater.tick("1.0.1"); expect(updater.status().installedVersion).toBe("1.0.0");
    expect((await b.tool()).result.structuredContent.version).toBe("1.0.0");
    await b.tool({ action: "finish", sessionId: "agent-b" }); await updater.tick("1.0.1");
    expect(updater.status().state).toBe("ready");
    for (const client of [a, b]) {
      const result = await client.tool({ text: "مرحبا 🌍" });
      expect(result.result.structuredContent.version).toBe("1.0.1");
      expect(result.result.structuredContent.args.text).toBe("مرحبا 🌍");
      expect(result.result.content[1].data).toBe("aW1hZ2U=");
      expect((await client.call("resources/read", { uri: "browser://sessions/test/artifacts/x" })).result.contents[0].blob).toBe("aW1hZ2U=");
      expect(client.child.exitCode).toBeNull();
    }
  } finally { await f.cleanup(); }
}, 30000);

test("incompatible candidate keeps the existing connection and version usable", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize(); await idleParticipants(f.dir);
    await expect(activateRelease(f.dir, { root: f.release("1.0.1", "number"), version: "1.0.1" }, async () => false)).rejects.toThrow("contract");
    expect((await client.tool()).result.structuredContent.version).toBe("1.0.0");
    expect(readJournal(f.dir)).toBeNull();
  } finally { await f.cleanup(); }
}, 30000);

test("new work during the final gate is queued and runs once on the new generation", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize(); await idleParticipants(f.dir);
    const switching = activateRelease(f.dir, { root: f.release("1.0.1"), version: "1.0.1" }, async () => false);
    while (!readJournal(f.dir)) await sleep(5);
    const call = client.tool({ action: "mutation" });
    expect(await switching).toBe(true);
    expect((await call).result.structuredContent.version).toBe("1.0.1");
    expect(fs.readFileSync(path.join(f.dir, "mutations"), "utf8")).toBe("once\n");
  } finally { await f.cleanup(); }
}, 30000);

test("retained sessions, approvals, unresolved crash state and extension activity block activation", async () => {
  const f = fixture();
  const participant = createParticipant(f.dir, "runtime", "1.0.0");
  try {
    const next = { root: f.release("1.0.1"), version: "1.0.1" };
    for (const state of [{ sessions: ["handoff"], approvals: 0 }, { sessions: [], approvals: 1 }]) {
      participant.publish(state); expect(await activateRelease(f.dir, next, async () => false)).toBe(false);
    }
    participant.publish({ approvals: 0 }); expect(await activateRelease(f.dir, next, async () => true)).toBe(false);
    participant.publish({ pid: 2147483647, sessions: ["orphan"] });
    expect(await activateRelease(f.dir, next, async () => false)).toBe(false);
    expect(participants(f.dir).some(row => row.sessions.includes("orphan"))).toBe(true);
  } finally { participant.close(); await f.cleanup(); }
});

test("UTF-8 split across stdio chunks survives the supervisor transport", () => {
  const messages: unknown[] = [], decode = lines(message => messages.push(message));
  const buffer = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "مرحبا 🌍" }) + "\n");
  for (const byte of buffer) decode(Buffer.from([byte]));
  expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "مرحبا 🌍" }]);
});

test("opting out during preparation aborts the switch without dropping MCP", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize(); await idleParticipants(f.dir);
    const root = f.release("1.0.1");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    atomicJson(path.join(root, "package.json"), { ...pkg, testInitDelay: 200 });
    const switching = activateRelease(f.dir, { root, version: "1.0.1" }, async () => false);
    const outcome = switching.then(value => ({ value, error: null as Error | null }), error => ({ value: false, error: error as Error }));
    while (!readJournal(f.dir)) await sleep(5);
    await createRuntimeUpdater({ dir: f.dir }).configure(false);
    expect((await outcome).error?.message).toContain("activity changed");
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")).autoUpdate).toBe(false);
    expect((await client.tool()).result.structuredContent.version).toBe("1.0.0");
  } finally { await f.cleanup(); }
}, 30000);

test("a worker crash returns uncertainty, never replays a mutation, and preserves the MCP connection", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize();
    const result = await client.tool({ action: "mutationCrash" });
    expect(result.error.data.uncertain).toBe(true);
    expect(fs.readFileSync(path.join(f.dir, "mutations"), "utf8")).toBe("once\n");
    expect(client.child.exitCode).toBeNull();
    expect((await client.tool()).result.structuredContent.version).toBe("1.0.0");
  } finally { await f.cleanup(); }
}, 30000);

test("a coordinator crash is reconciled from the atomic pointer before the next call", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize();
    const root = f.release("1.0.1");
    atomicJson(path.join(f.dir, "activation-journal.json"), { id: "crashed", pid: 2147483647, phase: "committed", previous: { root: f.root }, next: { root, version: "1.0.1", generation: 1 } });
    atomicJson(path.join(f.dir, "runtime.json"), { root, version: "1.0.1", generation: 1, autoUpdate: true });
    expect((await client.tool()).result.structuredContent.version).toBe("1.0.1");
    expect(readJournal(f.dir)).toBeNull();
  } finally { await f.cleanup(); }
}, 30000);

test("extension announcement replaces two real native hosts and MCP workers before releasing queued calls", async () => {
  const f = fixture(); let stopping = false, idle = false, starts = 0;
  const hosts = new Set<ReturnType<typeof spawn>>(); let stderr = "";
  const env = { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: f.dir,
    OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: path.join(f.dir, "profiles"), OPENCODE_BROWSER_MEMORY_DIR: path.join(f.dir, "memory"),
    AGENT_BROWSER_PROVIDER_DIR: path.join(f.dir, "providers"), AGENT_BROWSER_SEMANTIC_DIR: path.join(f.dir, "semantic"),
    AGENT_BROWSER_VISUAL_DIR: path.join(f.dir, "visual"), AGENT_BROWSER_ARTIFACT_DIR: path.join(f.dir, "artifacts") };
  async function until(predicate: () => boolean, timeout = 25000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) {
        const diagnostic = Object.fromEntries(["runtime.json", "update-status.json", "activation-journal.json"].map(name => [name, fs.existsSync(path.join(f.dir, name)) ? fs.readFileSync(path.join(f.dir, name), "utf8") : null]));
        throw new Error(`Update flow timed out: ${JSON.stringify(diagnostic)}; participants=${JSON.stringify(participants(f.dir))}; workers=${f.logs()}; hosts=${stderr}`);
      }
      await sleep(20);
    }
  }
  function actualRelease(root: string, version: string) {
    for (const folder of ["dist", "native-host/dist"]) fs.cpSync(path.join(process.cwd(), folder), path.join(root, folder), { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    atomicJson(path.join(root, "package.json"), { ...pkg, version });
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  function launch(profileId: string) {
    if (stopping) return;
    const selected = JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8"));
    const child = spawn("node", [path.join(selected.root, "native-host/dist/runtime.js")], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    starts++; hosts.add(child);
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.stdin?.on("error", () => {});
    const decoder = new FrameDecoder({ onMessage: message => {
      const value = message as { id?: number; method?: string };
      if (value.method === "runtime.canReconnect") void writeFrame(child.stdin!, { jsonrpc: "2.0", id: value.id, result: { idle } }).catch(() => {});
    } });
    child.stdout?.on("data", chunk => decoder.push(chunk));
    child.on("exit", () => { hosts.delete(child); if (!stopping) launch(profileId); });
    void writeFrame(child.stdin!, { jsonrpc: "2.0", id: 1, method: "profile.hello", params: { profileId, extensionVersion: "1.0.1", browserName: "Fixture", uploadConsentVersion: 1 } });
  }
  try {
    actualRelease(f.root, "1.0.0");
    const next = path.join(f.dir, "releases/1.0.1/node_modules/opencode-chromium");
    fs.mkdirSync(path.dirname(next), { recursive: true }); fs.renameSync(f.release("1.0.1"), next); actualRelease(next, "1.0.1");
    const a = f.client(env), b = f.client(env); await Promise.all([a.initialize(), b.initialize()]);
    launch("profile-a"); launch("profile-b");
    const status = () => { try { return JSON.parse(fs.readFileSync(path.join(f.dir, "update-status.json"), "utf8")); } catch { return {}; } };
    await until(() => status().state === "waiting");
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")).version).toBe("1.0.0");
    idle = true;
    await until(() => readJournal(f.dir)?.phase === "committed");
    const pending = a.call("tools/call", { name: "browser_observe", arguments: { mode: "capabilities" } });
    await until(() => status().state === "ready" && readJournal(f.dir) === null);
    expect((await pending).result.structuredContent.pluginVersion).toBe("1.0.1");
    expect((await b.call("tools/call", { name: "browser_observe", arguments: { mode: "capabilities" } })).result.structuredContent.pluginVersion).toBe("1.0.1");
    expect(starts).toBeGreaterThanOrEqual(4);
    expect(a.child.exitCode).toBeNull(); expect(b.child.exitCode).toBeNull();
  } finally {
    stopping = true;
    await Promise.all([...hosts].map(async child => { const exited = once(child, "exit"); child.stdin?.end(); await exited; }));
    await f.cleanup();
  }
}, 60000);

test("a cold MCP connection is warmed for activation and initializes only once externally", async () => {
  const f = fixture();
  try {
    const client = f.client();
    while (!participants(f.dir).some(row => row.kind === "supervisor")) await sleep(5);
    expect(await activateRelease(f.dir, { root: f.release("1.0.1"), version: "1.0.1" }, async () => false)).toBe(true);
    expect((await client.initialize()).result.serverInfo.version).toBe("1.0.1");
    expect((await client.tool()).result.structuredContent.version).toBe("1.0.1");
  } finally { await f.cleanup(); }
}, 30000);

test("cancellation IDs are translated back to the worker's request IDs", async () => {
  const f = fixture();
  try {
    const client = f.client(); await client.initialize();
    const call = client.tool({ action: "hold" });
    await sleep(20);
    client.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }) + "\n");
    expect((await call).result.structuredContent.cancelled).toBe(true);
  } finally { await f.cleanup(); }
});

test("malformed activity records fail closed and an orphan needs independent profile evidence", async () => {
  const f = fixture();
  const row = createParticipant(f.dir, "runtime", "1.0.0");
  try {
    const next = { root: f.release("1.0.1"), version: "1.0.1" };
    row.publish({ pid: 2147483647, sessions: ["crashed-session"], profiles: ["verified-profile"] });
    expect(await activateRelease(f.dir, next, async () => false)).toBe(false);
    expect(await activateRelease(f.dir, next, async () => false, () => ["verified-profile"])).toBe(true);
    const bad = path.join(f.dir, "participants/broken.json"); fs.writeFileSync(bad, "broken");
    const error = await activateRelease(f.dir, { root: f.root, version: "1.0.0" }, async () => false).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")).version).toBe("1.0.1");
  } finally { row.close(); await f.cleanup(); }
});

test("closing an idle harness during preparation does not strand the remaining connections", async () => {
  const f = fixture();
  try {
    const a = f.client(), b = f.client(); await Promise.all([a.initialize(), b.initialize()]); await idleParticipants(f.dir);
    const root = f.release("1.0.1");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    atomicJson(path.join(root, "package.json"), { ...pkg, testInitDelay: 200 });
    const switching = activateRelease(f.dir, { root, version: "1.0.1" }, async () => false);
    while (!readJournal(f.dir)) await sleep(5);
    const exited = once(b.child, "exit"); b.child.stdin?.end(); await exited;
    expect(await switching).toBe(true);
    expect((await a.tool()).result.structuredContent.version).toBe("1.0.1");
  } finally { await f.cleanup(); }
}, 30000);
