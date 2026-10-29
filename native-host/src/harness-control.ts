import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID,timingSafeEqual } from "node:crypto";
import { FrameDecoder,writeFrame } from "./framing.ts";
import { atomicJson,processAlive } from "./runtime-participants.ts";
import { runtimeDirectory } from "./runtime-lifecycle.ts";
import { safeClientVersion,type HarnessKind } from "../../src/shared/connections.ts";
import { record } from "../../src/shared/values.ts";

export interface HarnessControlRecord { id: string; pid: number; harness: HarnessKind; version: string; harnessVersion: string | null; socket: string; token: string; updatedAt: number }
function ownSocket(id: string) {
  if (process.platform === "win32") return "\\\\.\\pipe\\opencode-browser-agent-" + id;
  const name = "ocb-" + id.replaceAll("-", "") + ".sock", candidate = path.join(os.tmpdir(), name);
  // macOS limits sockaddr_un paths to 104 bytes, including the terminator.
  // Its per-user temporary directory can consume most of that allowance.
  return Buffer.byteLength(candidate) < 100 ? candidate : path.join("/tmp", name);
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export function harnessControls(dir = runtimeDirectory()): HarnessControlRecord[] {
  const folder = path.join(dir, "harness-links");
  try { return fs.readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    try {
      const row = record(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")) as unknown);
      if (!validId(row.id) || name !== row.id + ".json" || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || !processAlive(Number(row.pid)) ||
        !["codex", "opencode", "dsh", "claude", "mcp", "sdk"].includes(String(row.harness)) || row.socket !== ownSocket(row.id) || typeof row.token !== "string" || !/^[a-f0-9-]{36}$/.test(row.token) ||
        typeof row.updatedAt !== "number" || row.updatedAt < Date.now() - 90000 || row.updatedAt > Date.now() + 5000 || !safeClientVersion(row.version)) return [];
      return [row as unknown as HarnessControlRecord];
    } catch { return []; }
  }); } catch { return []; }
}
/** Only our plugin is refreshed. No harness process or unrelated MCP server is stopped. */
export async function startHarnessControl({ harness, version, harnessVersion, idle, reload, dir = runtimeDirectory() }: {
  harness: HarnessKind; version: string; harnessVersion?: unknown; idle(): boolean; reload(): Promise<void>; dir?: string;
}) {
  const id = randomUUID(), token = randomUUID(), socket = ownSocket(id), folder = path.join(dir, "harness-links");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, id + ".json");
  const row: HarnessControlRecord = { id, token, socket, pid: process.pid, harness, harnessVersion: safeClientVersion(harnessVersion), version, updatedAt: Date.now() };
  let running = false, closed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    sockets.add(client); client.once("close", () => sockets.delete(client));
    client.setTimeout(10000, () => client.destroy());
    const decoder = new FrameDecoder({ onMessage: async value => {
      const request = record(value), supplied = Buffer.from(String(request.token ?? "")), expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.method !== "refresh-browser-tools") { client.destroy(); return; }
      if (running || !idle()) { await writeFrame(client, { ok: false, code: "busy" }).catch(() => {}); return; }
      running = true;
      try { await reload(); await writeFrame(client, { ok: true, code: "refreshed" }); }
      catch { await writeFrame(client, { ok: false, code: "refresh_failed" }).catch(() => {}); }
      finally { running = false; }
    } });
    client.on("data", chunk => { try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { client.destroy(); } }); client.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  server.on("error", () => {});
  if (process.platform !== "win32") fs.chmodSync(socket, 0o600);
  server.unref();
  const publish = () => { row.updatedAt = Date.now(); try { atomicJson(file, row); } catch { /* Connection reporting must not interrupt tools. */ } };
  publish(); const timer = setInterval(publish, 15000); timer.unref();
  const close = () => {
    if (closed) return; closed = true; clearInterval(timer);
    for (const client of sockets) client.destroy();
    server.close(); try { fs.unlinkSync(file); } catch { /* Already removed. */ }
    if (process.platform !== "win32") try { fs.unlinkSync(socket); } catch { /* Server close may remove it. */ }
    process.removeListener("exit", close);
  };
  process.once("exit", close);
  return { id, close };
}
export function refreshHarnessControl(row: HarnessControlRecord, timeoutMs = 8000): Promise<{ ok: boolean; code: string }> {
  if (!validId(row.id) || row.socket !== ownSocket(row.id)) return Promise.resolve({ ok: false, code: "invalid_link" });
  return new Promise(resolve => {
    const client = net.createConnection(row.socket);
    let finished = false;
    const finish = (result: { ok: boolean; code: string }) => { if (finished) return; finished = true; clearTimeout(timer); client.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, code: "unreachable" }), timeoutMs);
    const decoder = new FrameDecoder({ onMessage: value => { const data = record(value); finish({ ok: data.ok === true, code: ["busy", "refreshed", "refresh_failed"].includes(String(data.code)) ? String(data.code) : "unreachable" }); } });
    client.once("connect", () => { void writeFrame(client, { method: "refresh-browser-tools", token: row.token }).catch(() => finish({ ok: false, code: "unreachable" })); });
    client.on("data", chunk => { try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { finish({ ok: false, code: "unreachable" }); } });
    client.once("error", () => finish({ ok: false, code: "unreachable" }));
    client.once("end", () => finish({ ok: false, code: "unreachable" }));
    client.once("close", () => finish({ ok: false, code: "unreachable" }));
  });
}
