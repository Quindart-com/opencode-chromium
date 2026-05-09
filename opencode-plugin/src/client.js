import net from "node:net";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.js";
import { defaultIpcPath } from "../../native-host/src/ipc-path.js";

const DEFAULT_TIMEOUT_MS = 10000;

export class BrowserHostRpcError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = "BrowserHostRpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export function validateJsonRpcResponse(message, expectedId, method = "unknown") {
  if (!message || typeof message !== "object") throw new Error(`Invalid browser host response to ${method}: expected object`);
  if (message.jsonrpc !== "2.0") throw new Error(`Invalid browser host response to ${method}: missing jsonrpc 2.0`);
  if (message.id !== expectedId) return null;

  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw new Error(`Invalid browser host response to ${method}: expected exactly one of result or error`);
  if (hasError) {
    const error = message.error && typeof message.error === "object" ? message.error : {};
    throw new BrowserHostRpcError(error.message ?? "Browser host RPC error", {
      code: error.code,
      data: error.data,
      method,
    });
  }
  return message.result;
}

export class BrowserHostClient {
  constructor({ ipcPath = defaultIpcPath(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.ipcPath = ipcPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      const id = 1;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Timed out waiting for browser host response to ${method}`)), true);
      }, this.timeoutMs);

      const cleanup = () => clearTimeout(timeout);
      const finish = (settle, destroy = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroy) socket.destroy();
        else socket.end();
        settle();
      };
      const decoder = new FrameDecoder({
        onMessage: (message) => {
          let result;
          try {
            result = validateJsonRpcResponse(message, id, method);
          } catch (error) {
            finish(() => reject(error), true);
            return;
          }
          if (result === null) return;
          finish(() => resolve(result));
        },
      });

      socket.on("connect", () => {
        writeFrame(socket, { jsonrpc: "2.0", method, params, id }).catch((error) => {
          finish(() => reject(error), true);
        });
      });

      socket.on("data", (chunk) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          finish(() => reject(error), true);
        }
      });

      socket.on("error", (error) => {
        finish(() => reject(new Error(`Could not connect to OpenCode browser host at ${this.ipcPath}: ${error.message}`)), true);
      });

      socket.on("close", () => {
        finish(() => reject(new Error(`Browser host connection closed before response to ${method}`)));
      });

      socket.on("end", () => {
        finish(() => reject(new Error(`Browser host connection ended before response to ${method}`)));
      });
    });
  }
}

export function browserRequest(method, params = {}, options = {}) {
  return new BrowserHostClient(options).request(method, params);
}
