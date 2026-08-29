import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const PRODUCT_DIR = "opencode-browser-plugin";
const MEMORY_DIR = "action-memory";

export const MEMORY_ENV_DIR = "OPENCODE_BROWSER_MEMORY_DIR";
export const MEMORY_ENV_FORCE = "OPENCODE_BROWSER_MEMORY";
export const MEMORY_ENV_EMBED = "OPENCODE_BROWSER_MEMORY_EMBED";

export const SCHEMA_VERSION = 2;
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;
export const MIN_QUOTA_BYTES = 1 * 1024 * 1024;
export const MAX_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_PURGE_DAYS = 7;
export const MIN_PURGE_DAYS = 1;
export const MAX_PURGE_DAYS = 365;

export const MAX_QUERY_EVENTS = 200;
export const DEFAULT_QUERY_EVENTS = 50;
export const MAX_SEARCH_RESULTS = 20;
export const DEFAULT_SEARCH_RESULTS = 3;
export const MAX_LABEL_CHARS = 64;
export const MAX_CHAIN_STEPS = 24;
export const COMPOSER_CANDIDATES = 16;

// Minimum embedding similarity for a memory candidate to be returned at all.
// Calibrated per embedding profile by scripts/benchmark-memory-threshold.js;
// values below the threshold are unrelated, not "least bad".
export const DEFAULT_MEMORY_SIMILARITY_THRESHOLD = 0.42;
export const MEMORY_SIMILARITY_THRESHOLDS = {
  "snowflake-arctic-embed-xs:q8:d384:prompt-v1": 0.42,
  "snowflake-arctic-embed-m:q8:d768:prompt-v1": 0.42,
  "embeddinggemma-300m:q4:d128:prompt-v1": 0.38,
  "embeddinggemma-300m:q4:d256:prompt-v1": 0.38,
  "embeddinggemma-300m:q4:d512:prompt-v1": 0.38,
  "embeddinggemma-300m:q4:d768:prompt-v1": 0.38,
  "qwen3-0.6b-retrieval:q8:d1024:prompt-v1": 0.40,
};
export const MEMORY_REPLAY_MIN_CONFIDENCE = 0.6;
export const MEMORY_EMBED_MAX_ATTEMPTS = 3;

export const WRITER_QUEUE_CAPACITY = 1024;
export const WRITER_FLUSH_MS = 500;
export const EMBED_BATCH_SIZE = 16;

export const STORAGE_PROFILE = "opencode-browser-plugin/action-memory/v1/sqlite+float32-cosine";

export function memoryRootDir() {
  if (process.env[MEMORY_ENV_DIR]) return path.resolve(process.env[MEMORY_ENV_DIR]);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, PRODUCT_DIR, MEMORY_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", PRODUCT_DIR, MEMORY_DIR);
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, PRODUCT_DIR, MEMORY_DIR);
}

export function databasePath(root = memoryRootDir()) {
  return path.join(root, "memory.db");
}

export function ensureMemoryDirs(root = memoryRootDir()) {
  fs.mkdirSync(root, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // best effort hardening; documented as non-Windows only
    }
  }
}

export function memoryEnabledForServer() {
  const force = process.env[MEMORY_ENV_FORCE];
  if (force === "1") return true;
  if (force === "0") return false;
  const root = memoryRootDir();
  if (!fs.existsSync(path.join(root, "memory.db"))) return false;
  try {
    const db = openDatabase(root);
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("enabled");
      const value = String(row?.value ?? "");
      return value === "true" || value === "1";
    } finally {
      closeDatabase(db);
    }
  } catch {
    return false;
  }
}

export function embeddingEnabled() {
  return process.env[MEMORY_ENV_EMBED] !== "0";
}

let sqliteModule = null;

export function sqliteImplementation() {
  if (sqliteModule) return sqliteModule;
  const require = createRequire(import.meta.url);
  if (typeof Bun !== "undefined") {
    try {
      sqliteModule = { kind: "bun", Database: require("bun:sqlite").Database };
      return sqliteModule;
    } catch {
      // fall through to node:sqlite
    }
  }
  try {
    sqliteModule = { kind: "node", Database: require("node:sqlite").DatabaseSync };
    return sqliteModule;
  } catch {
    return null;
  }
}

export function openDatabase(root = memoryRootDir()) {
  const impl = sqliteImplementation();
  if (!impl) throw new Error("No supported embedded SQLite runtime (bun:sqlite or node:sqlite)");
  ensureMemoryDirs(root);
  const db = new impl.Database(databasePath(root));
  if (impl.kind === "bun") {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  } else {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  }
  return db;
}

export function closeDatabase(db) {
  try {
    db.close();
  } catch {
    // already closed
  }
}

export function defaultConfig() {
  return {
    enabled: false,
    paused: false,
    quota_bytes: DEFAULT_QUOTA_BYTES,
    purge_days: DEFAULT_PURGE_DAYS,
    power_user: false,
    model_id: null,
    dims: null,
    embedding_profile: null,
    schema_version: SCHEMA_VERSION,
    legacy_v1_tagged: false,
    memory_hits: 0,
    embedding_attempts: 0,
    embedding_failures: 0,
    embedding_queue_drops: 0,
    last_embedding_error: null,
    last_reindex_at: null,
    created_at: null,
    last_prune_at: null,
    last_evict_at: null,
    quota_reached_once: false,
    dropped: 0,
  };
}