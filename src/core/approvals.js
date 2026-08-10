import { createHash, randomBytes } from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function requestDigest(request) {
  return createHash("sha256").update(JSON.stringify(stable(request))).digest("hex");
}

export class ApprovalStore {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  prune() {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }

  issue({ sessionId, request, reasons = [] }) {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    const stored = Object.freeze({
      sessionId: String(sessionId),
      request: structuredClone(request),
      digest: requestDigest(request),
      reasons: Object.freeze([...new Set(reasons)]),
      issuedAt: this.now(),
      expiresAt,
    });
    this.entries.set(token, stored);
    return { token, ...stored, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token, { sessionId } = {}) {
    this.prune();
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (!entry) {
      const error = new Error("Approval token is invalid or expired. Submit the action chain again for review.");
      error.code = "APPROVAL_TOKEN_INVALID";
      throw error;
    }
    if (sessionId && entry.sessionId !== String(sessionId)) {
      const error = new Error("Approval token belongs to a different browser session.");
      error.code = "APPROVAL_SESSION_MISMATCH";
      throw error;
    }
    return entry;
  }

  clear() {
    this.entries.clear();
  }
}
