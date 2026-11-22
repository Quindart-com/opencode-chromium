import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { lines, type Message } from "../../src/control/mcp-worker.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-supervisor-"));
  const root = path.join(dir, "release"), log = path.join(dir, "requests.jsonl");
  fs.mkdirSync(path.join(root, "dist/adapters/mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ root, version: "2.0.4", desired: { root, version: "2.0.4", contractVersion: 2 } }));
  fs.writeFileSync(path.join(root, "dist/adapters/mcp/server.js"), `
    import fs from 'node:fs';
    const log = ${JSON.stringify(log)};
    fs.appendFileSync(log, JSON.stringify({ method: 'spawn', pid: process.pid }) + '\\n');
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\\n'); if (end < 0) break;
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        fs.appendFileSync(log, JSON.stringify({ method: message.method, pid: process.pid }) + '\\n');
        if (message.method === 'tools/call') { process.exit(1); }
        if (message.id === undefined) continue;
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '2.0.4' } }
          : { pid: process.pid, tools: ['browser_run','browser_observe','browser_session','browser_finalize'].map(name => ({ name })) };
        const reply = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        if (message.method === 'initialize') setTimeout(reply, 50); else reply();
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  const entry = path.join(dir, "supervisor.mjs");
  fs.writeFileSync(entry, `import { superviseMcp } from ${JSON.stringify(new URL("../../src/control/mcp-supervisor.ts", import.meta.url).href)}; await superviseMcp(${JSON.stringify(dir)}, []);`);
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map<number, { resolve(value: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", lines(message => {
    const request = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (request) { clearTimeout(request.timer); pending.delete(message.id as number); request.resolve(message); }
  }));
  const exited = new Promise<void>(resolve => child.once("exit", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Supervisor exited: " + stderr)); }
    pending.clear(); resolve();
  }));
  const send = (message: Message) => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Supervisor request timed out: " + stderr)); }, 3000);
      pending.set(id, { resolve, reject, timer }); send({ jsonrpc: "2.0", id, method, params });
    });
  };
  return { dir, request, send,
    records: () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { method: string; pid: number }),
    async close() {
      child.stdin.end();
      const deadline = setTimeout(() => child.kill(), 2000);
      await exited; clearTimeout(deadline);
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith("mcp-supervisor-"));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const initialize = (f: ReturnType<typeof fixture>) => f.request("initialize", {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "0.167.0" },
});

test("managed handshake leaves catalog discovery to the client and initializes presence once", async () => {
  const f = fixture();
  try {
    assert.equal((await initialize(f)).error, undefined);
    assert.deepEqual(f.records().map(row => row.method), ["spawn", "initialize"]);
    f.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    f.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await f.request("tools/list");
    assert.equal((tools.result as { tools: unknown[] }).tools.length, 4);
    assert.deepEqual(f.records().map(row => row.method), ["spawn", "initialize", "notifications/initialized", "tools/list"]);
    const participants = fs.readdirSync(path.join(f.dir, "participants"));
    const lease = JSON.parse(fs.readFileSync(path.join(f.dir, "participants", participants[0]!), "utf8"));
    assert.equal(lease.harness, "codex"); assert.equal(lease.contractVersion, 2);
  } finally { await f.close(); }
});

test("concurrent catalog requests share one replacement worker without replaying an interrupted tool", async () => {
  const f = fixture();
  try {
    await initialize(f);
    f.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const interrupted = await f.request("tools/call", { name: "fixture_exit", arguments: {} });
    assert.match(JSON.stringify(interrupted.error), /exited.*not replayed/);
    const responses = await Promise.all([f.request("tools/list"), f.request("tools/list")]);
    assert.equal((responses[0]!.result as { pid: number }).pid, (responses[1]!.result as { pid: number }).pid);
    const records = f.records();
    assert.equal(records.filter(row => row.method === "spawn").length, 2);
    assert.equal(records.filter(row => row.method === "notifications/initialized").length, 2);
    assert.equal(records.filter(row => row.method === "tools/call").length, 1);
  } finally { await f.close(); }
});
