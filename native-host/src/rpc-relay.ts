import type { Writable } from "node:stream";
import { profileHelloSchema,rpcMessageSchema,type ProfileHello,type RpcId,type RpcMessage } from "../../src/shared/rpc.ts";
import { record } from "../../src/shared/values.ts";
import { writeFrame } from "./framing.ts";
import type { ProfileRegistration } from "./profile-registry.ts";
type RpcSocket = Pick<Writable, "write" | "on" | "destroy">;
export interface RelayState { startedAt: string; ipcPath?: string; profile: (ProfileRegistration & { uploadConsentVersion?: number }) | null; nativeHostVersion?: string; lastExtensionMessageAt?: string }
type PendingRequest = { socket: RpcSocket; clientId: RpcId; timeout: ReturnType<typeof setTimeout> };
type ExtensionWriter = (message: object) => unknown | Promise<unknown>;

const JSON_RPC_VERSION = "2.0";
const DEFAULT_RELAY_TIMEOUT_MS = 30000;

function requestTimeoutMs(message: RpcMessage) {
  const deadlineAt = message.params?.deadlineAt;
  if (typeof deadlineAt === "number") return Math.max(1, deadlineAt - Date.now() + 5000);
  const timeoutMs = message?.params?.timeoutMs ?? message?.params?.timeout_ms;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs + 5000) : DEFAULT_RELAY_TIMEOUT_MS;
}

export class RpcRelay {
  #extensionWriter: ExtensionWriter;
  #clients = new Set<RpcSocket>();
  #clientVersions = new Map<RpcSocket, string | null>();
  #coordinated = new Set<RpcSocket>();
  #admit: (() => Promise<() => void>) | undefined;
  #pendingRequests = new Map<number, PendingRequest>();
  #pendingBySocket = new Map<RpcSocket, Set<number>>();
  #nextRequestId = 1;
  #state: RelayState;
  #onProfile: ((profile: ProfileHello) => void) | undefined;
  #localHandler: ((method: string, params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  #hostPending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  constructor({ extensionWriter, state, onProfile, localHandler, admit }: { extensionWriter: ExtensionWriter; state: RelayState; onProfile?(profile: ProfileHello): void; localHandler?(method: string, params: Record<string, unknown>): unknown | Promise<unknown>; admit?(): Promise<() => void> }) {
    this.#extensionWriter = extensionWriter;
    this.#state = state;
    this.#onProfile = onProfile;
    this.#localHandler = localHandler;
    this.#admit = admit;
  }

  flushMemory() {
    // Native-host memory methods write directly to the store.
  }

  requestExtension(method: string, params: Record<string, unknown>, timeoutMs = 1500): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#hostPending.delete(id); reject(new Error("Extension request timed out")); }, timeoutMs);
      this.#hostPending.set(id, { resolve, reject, timer });
      Promise.resolve(this.#extensionWriter({ jsonrpc: JSON_RPC_VERSION, id, method, params })).catch(error => {
        clearTimeout(timer); this.#hostPending.delete(id); reject(error);
      });
    });
  }

  activity(observer = true) {
    return { clients: Math.max(0, this.#clients.size - Number(observer)), unmanaged: Math.max(0, this.#clients.size - this.#coordinated.size - Number(observer)), pending: this.#pendingRequests.size + this.#hostPending.size };
  }

  addClient(socket: RpcSocket) {
    this.#clients.add(socket);
    const cleanup = () => this.#removeClient(socket);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  #removeClient(socket: RpcSocket) {
    this.#clients.delete(socket);
    this.#coordinated.delete(socket);
    if (this.#clientVersions.delete(socket)) this.#broadcastVersions();
    const pendingIds = this.#pendingBySocket.get(socket) ?? new Set();
    for (const extensionId of pendingIds) this.#deletePending(extensionId);
    this.#pendingBySocket.delete(socket);
  }

  #setPending(extensionId: number, pending: PendingRequest) {
    this.#pendingRequests.set(extensionId, pending);
    let ids = this.#pendingBySocket.get(pending.socket);
    if (!ids) {
      ids = new Set();
      this.#pendingBySocket.set(pending.socket, ids);
    }
    ids.add(extensionId);
  }

  #deletePending(extensionId: number) {
    const pending = this.#pendingRequests.get(extensionId);
    if (!pending) return null;
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(extensionId);
    const ids = this.#pendingBySocket.get(pending.socket);
    ids?.delete(extensionId);
    if (ids && ids.size === 0) this.#pendingBySocket.delete(pending.socket);
    return pending;
  }

  async #writeClientError(socket: RpcSocket, id: RpcId, code: number, message: string, data?: unknown) {
    await writeFrame(socket, {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }).catch(() => {});
  }

  async handleClientMessage(socket: RpcSocket, input: unknown) {
    const parsed = rpcMessageSchema.parse(input);
    if (parsed.coordinated === true) this.#coordinated.add(socket);
    const leave = !["runtime.activity", "host.status"].includes(parsed.method ?? "") ? await this.#admit?.() : undefined;
    try { await this.#dispatchClientMessage(socket, parsed); } finally { leave?.(); }
  }

  async #dispatchClientMessage(socket: RpcSocket, input: unknown) {
    const message = rpcMessageSchema.parse(input);
    const commands: unknown[] = (message.method === "inputGesture" || message.method === "executeInputGesture") && Array.isArray(message.params.steps) ? message.params.steps : message?.method === "executeCdp" ? [message.params] : [];
    const hasFiles = commands.some(value => { const command = record(value), params = record(command.commandParams ?? command.command_params); const files = command.method === "DOM.setFileInputFiles" ? params.files : command.method === "Input.dispatchDragEvent" ? record(params.data).files : null; return Array.isArray(files) && files.length > 0; });
    if (hasFiles && this.#state.profile?.uploadConsentVersion !== 1) {
      if (message.id !== undefined) await this.#writeClientError(socket, message.id, -32000, "Reload the updated extension to enable upload confirmation; no files were uploaded");
      return;
    }
    if (message?.method?.startsWith("uploads.") || message?.method?.startsWith("firefox.") || message?.method?.startsWith("runtime.update")) {
      if (message.id !== undefined) await this.#writeClientError(socket, message.id, -32000, "This operation is restricted to the extension");
      return;
    }
    const observer = message?.method === "runtime.activity";
    if (!observer && typeof message?.clientVersion === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?(?:-[a-zA-Z0-9.-]{1,40})?$/.test(message.clientVersion) && this.#clientVersions.get(socket) !== message.clientVersion) {
      this.#clientVersions.set(socket, message.clientVersion);
      this.#broadcastVersions();
    } else if (!observer && !this.#clientVersions.has(socket)) {
      this.#clientVersions.set(socket, null);
      this.#broadcastVersions();
    }
    if (message?.method === "host.status") {
      if (message.id !== undefined) {
        await writeFrame(socket, {
          jsonrpc: JSON_RPC_VERSION,
          id: message.id,
          result: this.#status(),
        });
      }
      return;
    }

    if (message?.method && message.id !== undefined) {
      const local = await this.#handleLocalMethod(message.method, message.params ?? {});
      if (local.handled) {
        await writeFrame(socket, local.error ? {
          jsonrpc: JSON_RPC_VERSION,
          id: message.id,
          error: { code: -32000, message: local.error, data: local.errorData },
        } : {
          jsonrpc: JSON_RPC_VERSION,
          id: message.id,
          result: local.result,
        });
        return;
      }

      const extensionId = this.#nextRequestId++;
      const timeout = setTimeout(() => {
        const pending = this.#deletePending(extensionId);
        if (pending) {
          void this.#writeClientError(pending.socket, pending.clientId, -32000, `Timed out waiting for extension response to ${message.method}`);
        }
      }, requestTimeoutMs(message));
      this.#setPending(extensionId, {
        clientId: message.id,
        socket,
        timeout,
      });
      try {
        await this.#extensionWriter({ ...message, id: extensionId });
      } catch (error) {
        this.#deletePending(extensionId);
        await this.#writeClientError(socket, message.id, -32000, "Could not write request to browser extension", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    await this.#extensionWriter(message);
  }

  async #handleLocalMethod(method: string, params: Record<string, unknown>) {
    if (!this.#localHandler) return { handled: false };
    try {
      const result = await this.#localHandler(method, params);
      return result === undefined ? { handled: false } : { handled: true, result };
    } catch (error) {
      const fields = record(error);
      return {
        handled: true,
        error: error instanceof Error ? error.message : String(error),
        errorData: { code: fields.code, uncertain: fields.uncertain, retryable: fields.retryable, executionState: fields.executionState, details: fields.details },
      };
    }
  }

  async handleExtensionMessage(input: unknown) {
    const message = rpcMessageSchema.parse(input);
    this.#state.lastExtensionMessageAt = new Date().toISOString();

    if (message?.method) {
      if (message.method === "profile.hello") {
        await this.#handleProfileHello(message);
        return;
      }
      await this.#handleExtensionRequestOrNotification(message);
      return;
    }

    if (message?.id !== undefined) {
      await this.#handleExtensionResponse(message);
    }
  }

  #versions() {
    return {
      nativeHostVersion: this.#state.nativeHostVersion ?? null,
      clientVersions: [...new Set(this.#clientVersions.values())].filter((value): value is string => value !== null).sort(),
      unknownClientVersion: [...this.#clientVersions.values()].includes(null),
    };
  }

  #status() {
    return {
      ...this.#versions(),
      connected: true,
      ipcClients: this.#clients.size,
      lastExtensionMessageAt: this.#state.lastExtensionMessageAt ?? null,
      startedAt: this.#state.startedAt,
      profile: this.#state.profile ?? null,
    };
  }

  async #broadcastVersions() {
    try { await this.#extensionWriter({ jsonrpc: JSON_RPC_VERSION, method: "host.versions", params: this.#versions() }); }
    catch { /* A version notice must never interrupt browser work. */ }
  }

  async #handleProfileHello(message: RpcMessage) {
    const parsed = profileHelloSchema.safeParse(message.params);
    const profile = parsed.success ? parsed.data : null;
    if (!profile) {
      if (message.id !== undefined) {
        await this.#extensionWriter({
          jsonrpc: JSON_RPC_VERSION,
          id: message.id,
          error: { code: -32602, message: "profile.hello requires profileId" },
        });
      }
      return;
    }

    this.#onProfile?.(profile);
    if (message.id !== undefined) {
      await this.#extensionWriter({ jsonrpc: JSON_RPC_VERSION, id: message.id, result: { registered: true, ...this.#versions() } });
    }
  }

  async #handleExtensionResponse(message: RpcMessage) {
    if (typeof message.id !== "number") return;
    const hostPending = this.#hostPending.get(message.id);
    if (hostPending) {
      clearTimeout(hostPending.timer); this.#hostPending.delete(message.id);
      if (message.error) hostPending.reject(new Error(message.error.message)); else hostPending.resolve(message.result);
      return;
    }
    const pending = this.#deletePending(message.id);
    if (!pending) return;
    await writeFrame(pending.socket, { ...message, id: pending.clientId });
  }

  async #handleExtensionRequestOrNotification(message: RpcMessage) {
    if (message.id !== undefined) {
      await this.#respondToExtensionRequest(message);
      return;
    }

    const results = await Promise.allSettled([...this.#clients].map((client) => writeFrame(client, message)));
    let index = 0;
    for (const client of [...this.#clients]) {
      if (results[index]?.status === "rejected") this.#removeClient(client);
      index += 1;
    }
  }

  async #respondToExtensionRequest(message: RpcMessage) {
    if (!message.method) return;
    if (message.method === "ping") {
      await this.#extensionWriter({
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        result: "pong",
      });
      return;
    }

    const local = await this.#handleLocalMethod(message.method, message.params ?? {});
    if (local.handled) {
      await this.#extensionWriter(local.error ? {
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        error: { code: -32000, message: local.error, data: local.errorData },
      } : {
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        result: local.result,
      });
      return;
    }

    await this.#extensionWriter({
      jsonrpc: JSON_RPC_VERSION,
      id: message.id,
      error: {
        code: -32601,
        message: `Host method not found: ${message.method}`,
      },
    });
  }

  shutdown(message = "Browser extension disconnected") {
    for (const pending of this.#hostPending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.#hostPending.clear();
    for (const extensionId of [...this.#pendingRequests.keys()]) {
      const pending = this.#deletePending(extensionId);
      if (pending) void this.#writeClientError(pending.socket, pending.clientId, -32000, message);
    }
    for (const client of [...this.#clients]) client.destroy();
    this.#clients.clear();
    this.#pendingBySocket.clear();
  }
}
