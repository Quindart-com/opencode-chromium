import net from "node:net";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.js";
import { defaultIpcPath } from "../../native-host/src/ipc-path.js";

const DEFAULT_TIMEOUT_MS = 10000;

export class BrowserHostClient {
  constructor({ ipcPath = defaultIpcPath(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.ipcPath = ipcPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      const id = 1;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out waiting for browser host response to ${method}`));
      }, this.timeoutMs);

      const cleanup = () => clearTimeout(timeout);
      const decoder = new FrameDecoder({
        onMessage: (message) => {
          if (message.id !== id) return;
          cleanup();
          socket.end();
          if (message.error) reject(new Error(message.error.message ?? "Browser host RPC error"));
          else resolve(message.result);
        },
      });

      socket.on("connect", () => {
        writeFrame(socket, { jsonrpc: "2.0", method, params, id }).catch((error) => {
          cleanup();
          socket.destroy();
          reject(error);
        });
      });

      socket.on("data", (chunk) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          cleanup();
          socket.destroy();
          reject(error);
        }
      });

      socket.on("error", (error) => {
        cleanup();
        reject(new Error(`Could not connect to OpenCode browser host at ${this.ipcPath}: ${error.message}`));
      });
    });
  }
}

export function browserRequest(method, params = {}, options = {}) {
  return new BrowserHostClient(options).request(method, params);
}
