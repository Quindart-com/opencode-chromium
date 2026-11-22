// Private MCP transport used by the installed controller; Node built-ins only.
import { spawn,type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface Message { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
export function lines(onMessage: (message: Message) => void) {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) throw new Error("MCP frame exceeds the supervisor limit");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Message;
      if (message.jsonrpc !== "2.0" || (!message.method && message.id === undefined)) throw new Error("Invalid MCP frame");
      onMessage(message);
    }
  };
}
export class McpWorker {
  readonly child: ChildProcess;
  readonly identity = randomUUID();
  readonly root: string;
  initialized: Message | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve(message: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  #externalIds = new Map<string | number, number>();
  #dead: Error | null = null;
  get alive() { return this.#dead === null; }
  constructor(root: string, args: string[], env: NodeJS.ProcessEnv, notify: (message: Message, worker: McpWorker) => void) {
    this.root = root;
    this.child = spawn(process.execPath, [path.join(root, "dist/adapters/mcp/server.js"), ...args], {
      env: { ...env, OPENCODE_BROWSER_SUPERVISED: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const decode = lines(message => {
      const pending = typeof message.id === "number" && !message.method ? this.#pending.get(message.id) : undefined;
      if (pending && typeof message.id === "number") {
        clearTimeout(pending.timer); this.#pending.delete(message.id); pending.resolve(message);
      } else if (message.method) notify(message, this);
    });
    this.child.stdout?.on("data", chunk => { try { decode(chunk); } catch (error) { this.#fail(error); this.close(); } });
    this.child.stderr?.on("data", chunk => process.stderr.write(chunk));
    this.child.on("error", error => this.#fail(error));
    this.child.on("exit", (code, signal) => this.#fail(new Error(`Browser worker exited (${signal ?? code ?? "unknown"}); the interrupted call was not replayed`)));
    this.child.stdin?.on("error", error => this.#fail(error));
  }
  #fail(error: unknown) {
    this.#dead = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(this.#dead); }
    this.#pending.clear();
  }
  send(message: Message) {
    if (this.#dead) throw this.#dead;
    this.child.stdin?.write(JSON.stringify(message) + "\n");
  }
  async request(method: string, params?: Record<string, unknown>, externalId?: string | number, timeoutMs = 130000): Promise<Message> {
    if (this.#dead) throw this.#dead;
    const id = this.#nextId++;
    if (externalId !== undefined) this.#externalIds.set(externalId, id);
    try {
      return await new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("Browser worker timed out; the call was not replayed")); }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
      });
    } finally { if (externalId !== undefined) this.#externalIds.delete(externalId); }
  }
  notification(message: Message) {
    if (message.method === "notifications/cancelled") {
      const original = message.params?.requestId;
      const id = typeof original === "string" || typeof original === "number" ? this.#externalIds.get(original) : undefined;
      if (id === undefined) return;
      this.send({ ...message, params: { ...message.params, requestId: id } });
    } else this.send(message);
  }
  async initialize(params: Record<string, unknown>) {
    const initialized = await this.request("initialize", params, undefined, 15000);
    if (initialized.error) throw new Error("Candidate worker could not initialize");
    this.initialized = initialized;
    // Forward the handshake promptly. The client owns its initialized
    // notification and catalog requests; prefetching them here delays startup
    // and sends initialized twice when the client's notification arrives.
    return initialized;
  }
  close() { this.#fail(new Error("Browser worker closed")); this.child.stdin?.end(); this.child.kill(); }
}
