import { writeFrame } from "./framing.js";

const JSON_RPC_VERSION = "2.0";
const DEFAULT_RELAY_TIMEOUT_MS = 30000;

function requestTimeoutMs(message) {
  const timeoutMs = message?.params?.timeoutMs ?? message?.params?.timeout_ms;
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs + 5000) : DEFAULT_RELAY_TIMEOUT_MS;
}

export class RpcRelay {
  #extensionWriter;
  #clients = new Set();
  #pendingRequests = new Map();
  #pendingBySocket = new Map();
  #nextRequestId = 1;
  #state;

  constructor({ extensionWriter, state }) {
    this.#extensionWriter = extensionWriter;
    this.#state = state;
  }

  addClient(socket) {
    this.#clients.add(socket);
    const cleanup = () => this.#removeClient(socket);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  #removeClient(socket) {
    this.#clients.delete(socket);
    const pendingIds = this.#pendingBySocket.get(socket) ?? new Set();
    for (const extensionId of pendingIds) this.#deletePending(extensionId);
    this.#pendingBySocket.delete(socket);
  }

  #setPending(extensionId, pending) {
    this.#pendingRequests.set(extensionId, pending);
    let ids = this.#pendingBySocket.get(pending.socket);
    if (!ids) {
      ids = new Set();
      this.#pendingBySocket.set(pending.socket, ids);
    }
    ids.add(extensionId);
  }

  #deletePending(extensionId) {
    const pending = this.#pendingRequests.get(extensionId);
    if (!pending) return null;
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(extensionId);
    const ids = this.#pendingBySocket.get(pending.socket);
    ids?.delete(extensionId);
    if (ids && ids.size === 0) this.#pendingBySocket.delete(pending.socket);
    return pending;
  }

  async #writeClientError(socket, id, code, message, data) {
    await writeFrame(socket, {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }).catch(() => {});
  }

  async handleClientMessage(socket, message) {
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
      const extensionId = this.#nextRequestId++;
      const timeout = setTimeout(() => {
        const pending = this.#deletePending(extensionId);
        if (pending) void this.#writeClientError(pending.socket, pending.clientId, -32000, `Timed out waiting for extension response to ${message.method}`);
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

  async handleExtensionMessage(message) {
    this.#state.lastExtensionMessageAt = new Date().toISOString();

    if (message?.method) {
      await this.#handleExtensionRequestOrNotification(message);
      return;
    }

    if (message?.id !== undefined) {
      await this.#handleExtensionResponse(message);
    }
  }

  #status() {
    return {
      connected: true,
      ipcClients: this.#clients.size,
      lastExtensionMessageAt: this.#state.lastExtensionMessageAt ?? null,
      startedAt: this.#state.startedAt,
    };
  }

  async #handleExtensionResponse(message) {
    const pending = this.#deletePending(message.id);
    if (!pending) return;
    await writeFrame(pending.socket, { ...message, id: pending.clientId });
  }

  async #handleExtensionRequestOrNotification(message) {
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

  async #respondToExtensionRequest(message) {
    if (message.method === "ping") {
      await this.#extensionWriter({
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        result: "pong",
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
    for (const extensionId of [...this.#pendingRequests.keys()]) {
      const pending = this.#deletePending(extensionId);
      if (pending) void this.#writeClientError(pending.socket, pending.clientId, -32000, message);
    }
    for (const client of [...this.#clients]) client.destroy();
    this.#clients.clear();
    this.#pendingBySocket.clear();
  }
}
