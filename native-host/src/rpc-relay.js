import { writeFrame } from "./framing.js";

const JSON_RPC_VERSION = "2.0";

export class RpcRelay {
  #extensionWriter;
  #clients = new Set();
  #pendingRequests = new Map();
  #nextRequestId = 1;
  #state;

  constructor({ extensionWriter, state }) {
    this.#extensionWriter = extensionWriter;
    this.#state = state;
  }

  addClient(socket) {
    this.#clients.add(socket);
    socket.on("close", () => this.#clients.delete(socket));
    socket.on("error", () => this.#clients.delete(socket));
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
      this.#pendingRequests.set(extensionId, {
        clientId: message.id,
        socket,
      });
      await this.#extensionWriter({ ...message, id: extensionId });
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
    const pending = this.#pendingRequests.get(message.id);
    if (!pending) return;

    this.#pendingRequests.delete(message.id);
    await writeFrame(pending.socket, { ...message, id: pending.clientId });
  }

  async #handleExtensionRequestOrNotification(message) {
    if (message.id !== undefined) {
      await this.#respondToExtensionRequest(message);
      return;
    }

    for (const client of this.#clients) {
      await writeFrame(client, message).catch(() => {});
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
}
