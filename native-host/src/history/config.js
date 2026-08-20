import os from "node:os";
import path from "node:path";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";

const PRODUCT_DIR = "opencode-browser-plugin";
const HISTORY_DIR = "computer-history";

export const HISTORY_ENV_DIR = "OPENCODE_BROWSER_HISTORY_DIR";
export const HISTORY_ENV_FORCE = "OPENCODE_BROWSER_HISTORY";
export const RETENTION_DAYS = 7;
export const QUOTA_BYTES = 100 * 1024 * 1024;
export const MAX_QUERY_EVENTS = 200;
export const DEFAULT_QUERY_EVENTS = 50;
export const WRITER_QUEUE_CAPACITY = 512;
export const WRITER_FLUSH_MS = 500;
export const WRITER_SEAL_BYTES = 8 * 1024 * 1024;
export const WRITER_SEAL_HOURS_MS = 60 * 60 * 1000;
export const STORAGE_PROFILE = "opencode-browser-plugin-history-v1/aes-256-gcm+jsonl+cloudevents-json";
export const EVENT_SCHEMA = "urn:opencode-browser-plugin:schema:history-event:v0";

export function historyRootDir() {
  if (process.env[HISTORY_ENV_DIR]) return path.resolve(process.env[HISTORY_ENV_DIR]);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, PRODUCT_DIR, HISTORY_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", PRODUCT_DIR, HISTORY_DIR);
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, PRODUCT_DIR, HISTORY_DIR);
}

export function stateFilePath(root) {
  return path.join(root, "state.json");
}

export function keyFilePath(root) {
  return path.join(root, "key");
}

export function lockFilePath(root) {
  return path.join(root, "writer.lock");
}

export function chunkDir(root) {
  return path.join(root, "chunks");
}

export function defaultState() {
  return { enabled: false, paused: false, sequence: 0, dropped: 0, corrupt: false, admitted: false, createdAt: null };
}

export function readState(root) {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(root), "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState();
    return {
      enabled: parsed.enabled === true,
      paused: parsed.paused === true,
      sequence: Number.isInteger(parsed.sequence) && parsed.sequence > 0 ? parsed.sequence : 0,
      dropped: Number.isInteger(parsed.dropped) && parsed.dropped > 0 ? parsed.dropped : 0,
      corrupt: parsed.corrupt === true,
      admitted: parsed.admitted === true,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    };
  } catch {
    return defaultState();
  }
}

export function writeState(root, state) {
  mkdirSync(root, { recursive: true });
  const tmp = stateFilePath(root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, stateFilePath(root));
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort; documented as a non-Windows hardening step
    }
  }
}

export function chunkFiles(root) {
  const dir = chunkDir(root);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".chunk"))
      .map((name) => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

export function chunkBytes(root) {
  let total = 0;
  for (const file of chunkFiles(root)) {
    try {
      total += statSync(file).size;
    } catch {
      // skip missing file
    }
  }
  return total;
}

export function historyEnabledForServer() {
  const force = process.env[HISTORY_ENV_FORCE];
  if (force === "1") return true;
  if (force === "0") return false;
  return readState(historyRootDir()).enabled === true;
}