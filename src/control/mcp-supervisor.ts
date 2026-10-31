import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PRODUCT } from "../shared/product.ts";
import { desiredRuntime } from "../shared/runtime-config.ts";
import { createParticipant } from "./leases.ts";
import { McpWorker,lines,type Message } from "./mcp-worker.ts";
import { parseRuntimeActivation } from "./state.ts";

/**
 * A stdio MCP connection is a blue/green lease. It selects the desired release
 * before initialize and remains pinned for its lifetime; reconnecting creates a
 * new lease on the desired release without interrupting active sessions.
 */
export async function superviseMcp(dir: string, args = process.argv.slice(2)) {
  const selected = () => desiredRuntime(parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown));
  const release = selected();
  const participant = createParticipant(dir, "supervisor", release.version, release.root, { contractVersion: release.contractVersion, harness: "mcp" });
  const env = { ...process.env, [PRODUCT.runtimeEnvironment]: dir, AGENT_BROWSER_SESSION_ID: process.env.AGENT_BROWSER_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? `mcp-${randomUUID()}` };
  let worker: McpWorker | null = null;
  let init: Record<string, unknown> | null = null;
  let closed = false;
  const serverRequests = new Map<string, { original: string | number }>();
  const write = (message: Message) => process.stdout.write(JSON.stringify(message) + "\n");

  async function start() {
    if (worker?.alive) return worker;
    const child = new McpWorker(release.root, args, env, message => {
      if (message.method && message.id !== undefined) {
        const id = `${child.identity}:${message.id}`;
        serverRequests.set(id, { original: message.id });
        participant.publish({ inFlight: participant.state.inFlight + 1 });
        write({ ...message, id });
      } else write(message);
    });
    try {
      if (init) await child.initialize(init);
      if (closed) throw new Error("MCP connection closed during worker startup");
      worker = child;
      return child;
    } catch (error) { child.close(); throw error; }
  }

  async function dispatch(message: Message) {
    if (!message.method) {
      const routed = serverRequests.get(String(message.id));
      if (routed && worker) { serverRequests.delete(String(message.id)); worker.send({ ...message, id: routed.original }); participant.leave(); }
      return;
    }
    if (message.method === "notifications/initialized") { worker?.notification(message); return; }
    if (message.id === undefined) { worker?.notification(message); return; }
    let admitted = false;
    try {
      await participant.enter(); admitted = true;
      const desired = selected();
      participant.publish({ desiredVersion: desired.version, draining: desired.root !== release.root });
      if (message.method === "initialize") {
        if (init) throw new Error("MCP connection already initialized");
        init = message.params ?? {};
        const current = await start();
        participant.publish({ contractVersion: Number(current.contract || release.contractVersion) || release.contractVersion });
        write({ ...current.initialized!, id: message.id });
      } else {
        if (!init) throw new Error("Initialize the MCP connection first");
        const result = await (await start()).request(message.method, message.params, message.id);
        write({ ...result, id: message.id });
      }
    } catch (error) {
      if (!closed) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { uncertain: true, retryable: false } } });
    } finally { if (admitted) participant.leave(); }
  }

  const decode = lines(message => { void dispatch(message); });
  const statusTimer = setInterval(() => {
    try { const desired = selected(); participant.publish({ desiredVersion: desired.version, draining: desired.root !== release.root }); }
    catch { participant.publish({ draining: true }); }
  }, 15000); statusTimer.unref();
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(statusTimer); worker?.close(); participant.close();
  };
  process.stdin.on("data", chunk => { try { decode(chunk); } catch (error) { process.stderr.write(String(error) + "\n"); close(); process.exitCode = 1; process.stdin.destroy(); } });
  process.stdin.on("end", close);
  process.once("SIGTERM", () => { close(); process.exit(0); });
  process.once("SIGINT", () => { close(); process.exit(0); });
  process.once("exit", close);
}
