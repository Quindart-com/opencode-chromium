import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const INSTANCE_ID = `${process.pid}-${randomBytes(6).toString("hex")}`;

export function defaultIpcPath() {
  if (process.env.OPENCODE_BROWSER_IPC_PATH) {
    return process.env.OPENCODE_BROWSER_IPC_PATH;
  }

  if (process.platform === "win32") {
    return "\\\\.\\pipe\\opencode-browser";
  }

  return path.join(os.tmpdir(), "opencode-browser.sock");
}

export function instanceIpcPath() {
  if (process.env.OPENCODE_BROWSER_INSTANCE_IPC_PATH) {
    return process.env.OPENCODE_BROWSER_INSTANCE_IPC_PATH;
  }

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\opencode-browser-${INSTANCE_ID}`;
  }

  return path.join(os.tmpdir(), `opencode-browser-${INSTANCE_ID}.sock`);
}

export function isUnixSocketPath(ipcPath) {
  return !ipcPath.startsWith("\\\\.\\pipe\\");
}
