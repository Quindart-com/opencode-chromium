import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const URI_PREFIX = "browser://sessions/";

function safeSegment(value) {
  return String(value ?? "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "default";
}

function defaultArtifactRoot() {
  const configured = process.env.AGENT_BROWSER_ARTIFACT_DIR ?? process.env.OPENCODE_BROWSER_ARTIFACT_DIR;
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), "opencode-browser-plugin-artifacts", String(process.pid));
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "application/json") return ".json";
  if (mimeType?.startsWith("text/")) return ".txt";
  return ".bin";
}

export class ArtifactStore {
  constructor({ root = defaultArtifactRoot(), ttlMs = DEFAULT_TTL_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.metadata = new Map();
  }

  create({ sessionId, mimeType = "application/json", data, label = "artifact" }) {
    this.cleanupExpired();
    const id = randomUUID();
    const safeSession = safeSegment(sessionId);
    const directory = path.join(this.root, safeSession);
    fs.mkdirSync(directory, { recursive: true });

    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
    const filePath = path.join(directory, `${safeSegment(label)}-${id}${extensionForMime(mimeType)}`);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });

    const createdAt = Date.now();
    const meta = {
      artifactId: id,
      sessionId: String(sessionId),
      uri: `${URI_PREFIX}${encodeURIComponent(String(sessionId))}/artifacts/${id}`,
      mimeType,
      size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString(),
      filePath,
    };
    this.metadata.set(id, meta);
    this.#enforceLimit();
    return this.publicMetadata(meta);
  }

  publicMetadata(meta) {
    if (!meta) return null;
    const { filePath: _filePath, ...value } = meta;
    return value;
  }

  read(identifier, { sessionId } = {}) {
    const id = this.idFromIdentifier(identifier);
    const meta = this.metadata.get(id);
    const uriSessionId = this.sessionIdFromIdentifier(identifier);
    if (meta && uriSessionId !== null && meta.sessionId !== uriSessionId) return null;
    if (meta && sessionId !== undefined && meta.sessionId !== String(sessionId)) return null;
    if (!meta || Date.parse(meta.expiresAt) <= Date.now() || !fs.existsSync(meta.filePath)) {
      if (meta) this.#delete(meta);
      return null;
    }
    return { ...this.publicMetadata(meta), data: fs.readFileSync(meta.filePath) };
  }

  idFromIdentifier(identifier) {
    const value = String(identifier ?? "");
    if (!value.startsWith(URI_PREFIX)) return value;
    const match = /\/artifacts\/([^/?#]+)$/.exec(value);
    return match ? decodeURIComponent(match[1]) : value;
  }

  sessionIdFromIdentifier(identifier) {
    const value = String(identifier ?? "");
    if (!value.startsWith(URI_PREFIX)) return null;
    const match = new RegExp(`^${URI_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^/]+)/artifacts/`).exec(value);
    return match ? decodeURIComponent(match[1]) : null;
  }

  cleanupSession(sessionId) {
    for (const meta of [...this.metadata.values()]) {
      if (meta.sessionId === String(sessionId)) this.#delete(meta);
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (const meta of [...this.metadata.values()]) {
      if (Date.parse(meta.expiresAt) <= now || !fs.existsSync(meta.filePath)) this.#delete(meta);
    }
  }

  close() {
    for (const meta of [...this.metadata.values()]) this.#delete(meta);
    if (!fs.existsSync(this.root)) return;
    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          fs.rmdirSync(path.join(this.root, entry.name));
        } catch {
          // Never remove an artifact directory that contains untracked files.
        }
      }
      fs.rmdirSync(this.root);
    } catch {
      // A configured root may be shared or contain user files. Leave it intact.
    }
  }

  #delete(meta) {
    this.metadata.delete(meta.artifactId);
    try {
      fs.unlinkSync(meta.filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  #enforceLimit() {
    const entries = [...this.metadata.values()].sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      total -= entry.size;
      this.#delete(entry);
    }
  }
}

export function artifactUriTemplate() {
  return `${URI_PREFIX}{sessionId}/artifacts/{artifactId}`;
}
