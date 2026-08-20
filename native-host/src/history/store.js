import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_QUERY_EVENTS,
  EVENT_SCHEMA,
  MAX_QUERY_EVENTS,
  QUOTA_BYTES,
  RETENTION_DAYS,
  STORAGE_PROFILE,
  WRITER_FLUSH_MS,
  WRITER_QUEUE_CAPACITY,
  WRITER_SEAL_BYTES,
  WRITER_SEAL_HOURS_MS,
  chunkBytes,
  chunkDir,
  chunkFiles,
  defaultState,
  ensurePrivateDir,
  historyRootDir,
  lockFilePath,
  readState,
  stateFilePath,
  writeState,
} from "./config.js";
import { chunkKey, decryptRecord, destroyRootKey, encryptRecord, loadOrCreateRootKey } from "./crypto.js";
import { buildEvent, opaqueId } from "./events.js";

const AAD_PROFILE = "opencode-browser-plugin/history/v1/aad";
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 75;

function isoNow() {
  return new Date().toISOString();
}

function waitForLock(root) {
  const lockPath = lockFilePath(root);
  const started = Date.now();
  for (;;) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error("Another history operation is in progress; retry shortly.");
      }
      const wait = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < wait) {
        // local utility lock; brief busy wait is acceptable
      }
    }
  }
}

export async function withHistoryLock(root, fn) {
  const fd = waitForLock(root);
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockFilePath(root), { force: true });
    }
  }
}

export function historyHealth(state, { writerAlive = false } = {}) {
  if (state.corrupt) return "storage_corrupt";
  if (!state.enabled) return "disabled";
  if (state.paused) return "paused";
  if (state.dropped > 0) return "events_dropped";
  if (!writerAlive) return "writer_stopped";
  return "ready";
}

export class HistoryStore {
  constructor({ root } = {}) {
    this.root = root ?? historyRootDir();
    this.queue = [];
    this.closed = false;
    this.writerTimer = null;
    this.openChunk = null;
    this.lastSealAt = Date.now();
    this.writerAlive = false;
    ensurePrivateDir(this.root);
    ensurePrivateDir(chunkDir(this.root));
    this.state = readState(this.root);
    this.stateLoadedAt = Date.now();
  }

  loadState() {
    this.state = readState(this.root);
    this.stateLoadedAt = Date.now();
    return this.state;
  }

  refreshState() {
    if (this.stateLoadedAt && Date.now() - this.stateLoadedAt < 2000) return this.state;
    return this.loadState();
  }

  persistState() {
    this.stateLoadedAt = Date.now();
    writeState(this.root, this.state);
  }

  #nextSequence() {
    this.state.sequence += 1;
    return this.state.sequence;
  }

  #enqueue(event) {
    if (this.queue.length >= WRITER_QUEUE_CAPACITY) {
      this.state.dropped += 1;
      this.persistState();
      return false;
    }
    this.queue.push(event);
    if (this.queue.length >= 64) this.flushSync();
    return true;
  }

  record({ kind, sessionId = null, actionId = null, capability = null, callerCategory = "agent_runtime", application = null, payload = null }) {
    this.refreshState();
    if (!this.state.enabled || this.state.paused) return { accepted: false, reason: this.state.paused ? "paused" : "disabled" };
    const event = buildEvent({
      root: this.root,
      sequence: this.#nextSequence(),
      kind,
      sessionId,
      actionId,
      capability,
      callerCategory,
      application,
      payload,
    });
    this.persistState();
    return { accepted: this.#enqueue(event), event };
  }

  startWriter() {
    if (this.writerTimer || this.closed) return;
    this.writerAlive = true;
    this.writerTimer = setInterval(() => this.flushSync(), WRITER_FLUSH_MS);
    if (this.writerTimer.unref) this.writerTimer.unref();
  }

  stopWriter() {
    if (this.writerTimer) {
      clearInterval(this.writerTimer);
      this.writerTimer = null;
    }
    this.flushSync();
    this.sealChunk();
    this.writerAlive = false;
  }

  #openChunkFile() {
    const dir = chunkDir(this.root);
    const chunkId = opaqueId();
    const created = Date.now();
    const header = JSON.stringify({ v: 1, profile: STORAGE_PROFILE, chunkId, created: isoNow(), sealed: false });
    const file = path.join(dir, `${created}-${chunkId}.chunk`);
    const fd = openSync(file, "a", 0o600);
    writeSync(fd, `${header}\n`, null, "utf8");
    return { chunkId, file, fd };
  }

  sealChunk() {
    if (!this.openChunk) return;
    try {
      fsyncSync(this.openChunk.fd);
    } catch {
      // best effort
    }
    try {
      closeSync(this.openChunk.fd);
    } catch {
      // already closed
    }
    this.openChunk = null;
  }

  flushSync() {
    if (this.closed || this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    if (this.state.corrupt) {
      this.state.dropped += batch.length;
      this.persistState();
      return;
    }
    if (chunkBytes(this.root) + batch.length * 256 >= QUOTA_BYTES) {
      this.state.dropped += batch.length;
      this.persistState();
      return;
    }
    try {
      if (!this.openChunk) this.openChunk = this.#openChunkFile();
      const rootKey = loadOrCreateRootKey(this.root);
      const key = chunkKey(rootKey, this.openChunk.chunkId);
      const aad = JSON.stringify({ profile: AAD_PROFILE, chunkId: this.openChunk.chunkId });
      const lines = batch.map((event) => JSON.stringify(encryptRecord(key, aad, JSON.stringify(event))));
      if (statSync(this.openChunk.file).size > WRITER_SEAL_BYTES) this.sealChunk();
      if (!this.openChunk) this.openChunk = this.#openChunkFile();
      for (const line of lines) {
        writeSync(this.openChunk.fd, `${line}\n`, null, "utf8");
      }
      if (Date.now() - this.lastSealAt >= WRITER_SEAL_HOURS_MS) {
        this.sealChunk();
        this.lastSealAt = Date.now();
      }
      this.pruneExpired();
    } catch {
      this.state.corrupt = true;
      this.persistState();
    }
  }

  pruneExpired(now = Date.now()) {
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of chunkFiles(this.root)) {
      if (!readChunk(file).ok) continue;
      if (chunkFileMtime(file) < cutoff) rmSync(file, { force: true });
    }
  }

  *readEvents({ now = Date.now() } = {}) {
    const rootKey = loadOrCreateRootKey(this.root);
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (!rootKey) return;
    for (const file of chunkFiles(this.root)) {
      const chunk = readChunk(file);
      if (!chunk.ok) return;
      const key = chunkKey(rootKey, chunk.header.chunkId);
      const aad = JSON.stringify({ profile: AAD_PROFILE, chunkId: chunk.header.chunkId });
      const lines = chunk.body;
      for (let index = 0; index < lines.length; index += 1) {
        let event = null;
        try {
          event = JSON.parse(decryptRecord(key, aad, JSON.parse(lines[index])));
        } catch {
          const isTail = index === lines.length - 1 && chunk.header.sealed !== true;
          if (isTail) return;
          yield { corrupt: "unauthenticated or malformed record in history chunk" };
          return;
        }
        if (!event?.data || event.dataschema !== EVENT_SCHEMA) {
          yield { corrupt: "unsupported history event schema" };
          return;
        }
        const at = Date.parse(event.time);
        if (!Number.isFinite(at) || at < cutoff) continue;
        yield event;
      }
    }
  }

  list({ limit = DEFAULT_QUERY_EVENTS } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    const collected = [];
    for (const event of this.readEvents()) {
      if (event?.corrupt) break;
      collected.push(event);
    }
    return { events: collected.slice(-bound), metadata_only: true };
  }

  show(sequence) {
    if (!Number.isInteger(sequence) || sequence < 1) return { event: null };
    for (const event of this.readEvents()) {
      if (event?.corrupt) break;
      if (event.data?.sequence === sequence) return { event };
    }
    return { event: null };
  }

  query({ limit = DEFAULT_QUERY_EVENTS, sessionId = null, sinceSequence = null, untilSequence = null } = {}) {
    const bound = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_QUERY_EVENTS) : DEFAULT_QUERY_EVENTS;
    let healthWarning = null;
    const collected = [];
    for (const event of this.readEvents()) {
      if (event?.corrupt) {
        healthWarning = event.corrupt;
        break;
      }
      const seq = event.data?.sequence;
      if (sinceSequence !== null && seq < sinceSequence) continue;
      if (untilSequence !== null && seq > untilSequence) continue;
      if (sessionId && event.data?.session_id !== sessionId) continue;
      collected.push(event);
    }
    const events = collected.slice(-bound);
    if (events.length > 0 && !healthWarning) {
      this.record({
        kind: "access",
        callerCategory: "agent_runtime",
        payload: { kind: "access", operation: "agent_query", returned: events.length },
      });
    }
    return {
      events,
      metadata_only: true,
      model_context_disclosure: true,
      ...(healthWarning ? { health_warning: healthWarning } : {}),
    };
  }

  status() {
    return {
      supported: true,
      admitted: this.state.admitted,
      enabled: this.state.enabled,
      paused: this.state.paused,
      encrypted: true,
      profile: STORAGE_PROFILE,
      retention_days: RETENTION_DAYS,
      quota_bytes: QUOTA_BYTES,
      bytes_used: chunkBytes(this.root),
      dropped_events: this.state.dropped,
      health: historyHealth(this.state, { writerAlive: this.writerAlive }),
    };
  }

  enable() {
    this.loadState();
    this.state.admitted = true;
    this.state.enabled = true;
    this.state.paused = false;
    this.state.corrupt = false;
    this.persistState();
    if (!selfTestBytes(this.root)) {
      this.state.enabled = false;
      this.persistState();
      throw new Error("History encryption self-test failed; capture stays disabled.");
    }
    this.record({ kind: "control", payload: { kind: "control", operation: "enable" } });
    this.flushSync();
    this.startWriter();
    return this.status();
  }

  disable() {
    this.record({ kind: "control", payload: { kind: "control", operation: "disable" } });
    this.flushSync();
    this.stopWriter();
    this.loadState();
    this.state.enabled = false;
    this.state.paused = false;
    this.persistState();
    return this.status();
  }

  pause() {
    this.record({ kind: "control", payload: { kind: "control", operation: "pause" } });
    this.flushSync();
    this.stopWriter();
    this.loadState();
    this.state.paused = true;
    this.persistState();
    return this.status();
  }

  resume() {
    this.loadState();
    this.state.paused = false;
    this.persistState();
    this.record({ kind: "control", payload: { kind: "control", operation: "resume" } });
    this.flushSync();
    return this.status();
  }

  hardDelete() {
    this.stopWriter();
    destroyRootKey(this.root);
    const dir = chunkDir(this.root);
    try {
      for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { force: true });
      rmSync(dir, { force: true, recursive: true });
    } catch {
      // directory absent
    }
    rmSync(stateFilePath(this.root), { force: true });
    this.state = defaultState();
    return { deleted: true, message: "History store and its encryption key were deleted." };
  }

  close() {
    this.closed = true;
    this.stopWriter();
  }
}

function chunkFileMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readChunk(file) {
  try {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const header = JSON.parse(lines[0]);
    if (!header?.chunkId || header.profile !== STORAGE_PROFILE) return { ok: false };
    return { ok: true, header, body: lines.slice(1) };
  } catch {
    return { ok: false };
  }
}

function selfTestBytes(root) {
  const key = loadOrCreateRootKey(root);
  const record = encryptRecord(key, "self-test", "opencode-browser-plugin history self-test");
  const back = decryptRecord(key, "self-test", record);
  return back === "opencode-browser-plugin history self-test";
}