import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTANCE_ID = `${process.pid}-${randomBytes(6).toString("hex")}`;
export function defaultIpcPath() { const configured = process.env.AGENT_BROWSER_IPC_PATH ?? process.env.OPENCODE_BROWSER_IPC_PATH; if (configured) return configured; return process.platform === "win32" ? "\\\\.\\pipe\\agent-browser" : path.join(os.tmpdir(), "agent-browser.sock"); }
export function instanceIpcPath() { const configured = process.env.AGENT_BROWSER_INSTANCE_IPC_PATH ?? process.env.OPENCODE_BROWSER_INSTANCE_IPC_PATH; if (configured) return configured; return process.platform === "win32" ? `\\\\.\\pipe\\agent-browser-${INSTANCE_ID}` : path.join(os.tmpdir(), `agent-browser-${INSTANCE_ID}.sock`); }
export function isUnixSocketPath(ipcPath: string) { return !ipcPath.startsWith("\\\\.\\pipe\\"); }

export function readJsonIfPresent<T = Record<string, unknown>>(filePath: fs.PathLike): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as T; }
  catch { return null; }
}

export function isFile(filePath: fs.PathLike): boolean {
  try { return fs.statSync(filePath).isFile(); }
  catch { return false; }
}

export function samePath(first: string | null | undefined, second: string | null | undefined): boolean {
  if (typeof first !== "string" || typeof second !== "string") return false;
  return first.replaceAll("\\", "/").toLowerCase() === second.replaceAll("\\", "/").toLowerCase();
}
