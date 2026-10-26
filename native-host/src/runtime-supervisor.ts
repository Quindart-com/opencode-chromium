import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createParticipant,readJournal,type SwitchJournal } from "./runtime-participants.ts";
import { McpWorker,lines,type Message } from "./runtime-worker.ts";

export async function superviseMcp(dir: string, args = process.argv.slice(2)) {
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as { root: string; version: string; generation?: number };
  const initial = manifest();
  const participant = createParticipant(dir, "supervisor", initial.version, initial.root);
  const env = { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: dir, AGENT_BROWSER_SESSION_ID: process.env.AGENT_BROWSER_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? `mcp-${randomUUID()}` };
  let worker: McpWorker | null = null, candidate: McpWorker | null = null, previous: McpWorker | null = null;
  let init: Record<string, unknown> | null = null, contract = "", preparing = "", checking = false, closed = false;
  let starting: Promise<McpWorker> | null = null;
  const serverRequests = new Map<string, { worker: McpWorker; original: string | number }>();
  const write = (message: Message) => process.stdout.write(JSON.stringify(message) + "\n");
  const notify = (message: Message, source: McpWorker) => {
    if (source !== worker) return;
    if (message.method && message.id !== undefined) {
      const id = `${source.identity}:${message.id}`;
      serverRequests.set(id, { worker: source, original: message.id });
      participant.publish({ inFlight: participant.state.inFlight + 1 });
      write({ ...message, id });
    } else write(message);
  };
  async function start(root: string) {
    const child = new McpWorker(root, args, env, notify);
    try {
      if (init) await child.initialize(init);
      if (closed) throw new Error("MCP connection closed during worker startup");
      return child;
    } catch (error) { child.close(); throw error; }
  }
  async function active() {
    const target = manifest();
    if (worker?.root === target.root && worker.alive) {
      if (init && !worker.initialized) await worker.initialize(init);
      return worker;
    }
    if (!starting) starting = (async () => {
      const replacement = candidate?.root === target.root ? candidate : previous?.root === target.root ? previous : await start(target.root);
      if (contract && replacement.contract !== contract) { replacement.close(); throw new Error("MCP contract changed; reconnect this server to use the update"); }
      const old = worker; worker = replacement;
      if (replacement === candidate) candidate = null;
      if (replacement === previous) previous = null;
      if (old && old !== replacement) {
        if (readJournal(dir)) previous = old; else old.close();
      }
      participant.publish({ root: target.root, version: target.version });
      return replacement;
    })().finally(() => { starting = null; });
    return starting;
  }
  async function prepare(journal: SwitchJournal) {
    if (participant.state.inFlight || preparing === journal.id) return;
    preparing = journal.id;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(journal.next.root, "package.json"), "utf8")) as { runtimeSupervisorProtocol?: number };
      if (pkg.runtimeSupervisorProtocol !== 1) throw new Error("Candidate needs a newer supervisor; reconnect MCP after setup");
      if (!init) {
        // Even a connected harness that has not initialized MCP yet must not
        // acknowledge an untested candidate. Its real handshake stays deferred.
        const probe = new McpWorker(journal.next.root, args, env, () => {});
        try { await probe.initialize({ protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "managed-supervisor-probe", version: "1" } }); }
        finally { probe.close(); }
        participant.publish({ prepared: journal.id, error: undefined }); return;
      }
      candidate = await start(journal.next.root);
      if (contract && candidate.contract !== contract) throw new Error("MCP contract changed; reconnect MCP to use this release");
      participant.publish({ prepared: journal.id, error: undefined });
    } catch (error) { candidate?.close(); candidate = null; participant.publish({ error: error instanceof Error ? error.message : String(error) }); }
  }
  async function check() {
    if (checking || closed) return;
    checking = true;
    try {
      const journal = readJournal(dir);
      if (journal?.phase === "preparing") await prepare(journal);
      else if (journal?.phase === "committed") { await active(); participant.publish({ committed: journal.id }); }
      else if (journal?.phase === "aborted") { await active(); candidate?.close(); candidate = null; }
      else {
        if (init && !participant.state.inFlight) await active();
        previous?.close(); previous = null; candidate?.close(); candidate = null;
        preparing = "";
        if (participant.state.prepared || participant.state.committed || participant.state.error) participant.publish({ prepared: undefined, committed: undefined, error: undefined });
      }
    } catch (error) { participant.publish({ error: error instanceof Error ? error.message : String(error) }); }
    finally { checking = false; }
  }
  const timer = setInterval(() => { void check(); }, 50);
  async function dispatch(message: Message) {
    if (!message.method) {
      const routed = serverRequests.get(String(message.id));
      if (routed) { serverRequests.delete(String(message.id)); routed.worker.send({ ...message, id: routed.original }); participant.leave(); }
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.id === undefined) { worker?.notification(message); return; }
    let admitted = false;
    try {
      await participant.enter(); admitted = true;
      if (message.method === "initialize") {
        if (init) throw new Error("MCP connection already initialized");
        init = message.params ?? {};
        const current = await active(); contract = current.contract;
        write({ ...current.initialized!, id: message.id });
      } else {
        if (!init) throw new Error("Initialize the MCP connection first");
        const current = await active();
        const result = await current.request(message.method, message.params, message.id);
        write({ ...result, id: message.id });
      }
    } catch (error) {
      if (!closed) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { uncertain: true, retryable: false } } });
    } finally { if (admitted) participant.leave(); }
  }
  const decode = lines(message => { void dispatch(message); });
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); worker?.close(); candidate?.close(); previous?.close(); participant.close();
  };
  process.stdin.on("data", chunk => { try { decode(chunk); } catch (error) { process.stderr.write(String(error) + "\n"); close(); process.exitCode = 1; process.stdin.destroy(); } });
  process.stdin.on("end", close);
  process.once("SIGTERM", () => { close(); process.exit(0); });
  process.once("SIGINT", () => { close(); process.exit(0); });
  process.once("exit", close);
}
