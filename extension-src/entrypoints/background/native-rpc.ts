import type { Browser,WxtBrowser } from "wxt/browser";
import { record } from "../../../src/shared/values.ts";
import { commandParamsSchema,type CommandParams } from "./command-schema.ts";
import { beforeDeadline } from "../../../src/shared/deadline.ts";

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RpcStatusPatch {
  state?: string;
  error?: string | null;
  nextRetryMs?: number | null;
  versionChecked?: boolean;
  nativeHostVersion?: string | null;
  clientVersions?: string[];
  unknownClientVersion?: boolean;
}

export class NativeRpc {
  readonly #handlers = new Map<string, (params: CommandParams) => Promise<unknown>>();
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #activeHandlers = 0;
  #port: Browser.runtime.Port | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: {
    chrome: WxtBrowser; hostName: string; timeoutMs: number;
    status(patch: RpcStatusPatch): void;
    connected(): void;
    disconnected(): void;
  };
  constructor(options: NativeRpc["options"]) { this.options = options; }

  register(method: string, handler: (params: CommandParams) => Promise<unknown>): void { this.#handlers.set(method, handler); }
  idle(): boolean { return this.#pending.size === 0 && this.#activeHandlers === 0; }

  connect(): void {
    if (this.#port) return;
    try {
      this.#port = this.options.chrome.runtime.connectNative(this.options.hostName);
      this.options.status({ state: "connected", error: null, nextRetryMs: null, versionChecked: false, nativeHostVersion: null, clientVersions: [], unknownClientVersion: false });
      this.#port.onMessage.addListener((message: unknown) => { void this.#handleMessage(message); });
      this.#port.onDisconnect.addListener(() => {
        this.options.disconnected();
        const error = this.options.chrome.runtime.lastError;
        this.#port = null;
        this.#rejectPending(error?.message ?? "Native host disconnected");
        this.options.status({ state: "disconnected", error: error?.message ?? null });
        this.#scheduleReconnect();
      });
      this.options.connected();
    } catch (error) {
      this.options.status({ state: "disconnected", error: String(error instanceof Error ? error.message : error) });
      this.#scheduleReconnect();
    }
  }

  async notify(method: string, params: object): Promise<void> {
    try { this.#post({ jsonrpc: "2.0", method, params }); } catch { this.connect(); }
  }

  async request(method: string, params: object, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const id = this.#nextId++;
    const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.options.timeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Native host request timed out after ${timeoutMs}ms: ${method}`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try { this.#post({ jsonrpc: "2.0", method, params, id }); } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.#pending.delete(id);
      throw error;
    }
    return promise;
  }

  heartbeat(): void {
    if (!this.#port) { this.connect(); return; }
    void this.request("ping", { time: new Date().toISOString() }).catch(error => {
      this.options.status({ state: "disconnected", error: String(error instanceof Error ? error.message : error) });
      this.#rejectPending("Native host heartbeat failed");
      this.#port?.disconnect(); this.#port = null; this.#scheduleReconnect();
    });
  }

  #post(message: object): void {
    if (!this.#port) throw new Error("Native host is not connected");
    this.#port.postMessage(message);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.options.status({ state: "reconnecting", nextRetryMs: 1000 });
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = null; this.connect(); }, 1000);
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(message)); }
    this.#pending.clear();
  }

  async #handleMessage(value: unknown): Promise<void> {
    const message = record(value);
    if (typeof message.method === "string") {
      const handler = this.#handlers.get(message.method);
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
      if (!handler) { if (id !== undefined) this.#post({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
      const observer = message.method === "runtime.canReconnect";
      try {
        const params = commandParamsSchema.parse(message.params ?? {});
        const result = await beforeDeadline(async () => {
          if (!observer) this.#activeHandlers++;
          try { return await handler(params); }
          finally { if (!observer) this.#activeHandlers--; }
        }, (params.deadlineAt ?? Date.now() + 120000) + 100, { method: message.method, tabId: params.tabId ?? params.target?.tabId, phase: "extension handler" });
        if (id !== undefined) this.#post({ jsonrpc: "2.0", id, result });
      } catch (error) {
        const fields = record(error);
        if (id !== undefined) this.#post({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { code: fields.code, uncertain: fields.uncertain, retryable: fields.retryable, executionState: fields.executionState, details: fields.details } } });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id); clearTimeout(pending.timeout);
    if (message.error) pending.reject(Object.assign(new Error(String(record(message.error).message ?? "RPC error")), record(record(message.error).data)));
    else pending.resolve(message.result);
  }
}
