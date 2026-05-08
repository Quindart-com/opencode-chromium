import os from "node:os";
import path from "node:path";

export function defaultIpcPath() {
  if (process.env.OPENCODE_BROWSER_IPC_PATH) {
    return process.env.OPENCODE_BROWSER_IPC_PATH;
  }

  if (process.platform === "win32") {
    return "\\\\.\\pipe\\opencode-browser";
  }

  return path.join(os.tmpdir(), "opencode-browser.sock");
}

export function isUnixSocketPath(ipcPath) {
  return !ipcPath.startsWith("\\\\.\\pipe\\");
}
