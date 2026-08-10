import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const INSTANCE_ID = `${process.pid}-${randomBytes(6).toString("hex")}`;

export function defaultIpcPath() {
  const configured = process.env.AGENT_BROWSER_IPC_PATH ?? process.env.OPENCODE_BROWSER_IPC_PATH;
  if (configured) {
    return configured;
  }

  if (process.platform === "win32") {
    return "\\\\.\\pipe\\agent-browser";
  }

  return path.join(os.tmpdir(), "agent-browser.sock");
}

export function instanceIpcPath() {
  const configured = process.env.AGENT_BROWSER_INSTANCE_IPC_PATH ?? process.env.OPENCODE_BROWSER_INSTANCE_IPC_PATH;
  if (configured) {
    return configured;
  }

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\agent-browser-${INSTANCE_ID}`;
  }

  return path.join(os.tmpdir(), `agent-browser-${INSTANCE_ID}.sock`);
}

export function isUnixSocketPath(ipcPath) {
  return !ipcPath.startsWith("\\\\.\\pipe\\");
}
