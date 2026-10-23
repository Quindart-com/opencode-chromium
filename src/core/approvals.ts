import { createHash,randomBytes } from "node:crypto";
import { canonicalJson } from "../shared/canonical-json.ts";
import { BrowserRuntimeError } from "./errors.ts";

export function requestDigest(request: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(request))).digest("hex");
}

interface Approval<T> {
  readonly sessionId: string;
  readonly request: T;
  readonly digest: string;
  readonly reasons: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class ApprovalStore<T = unknown> {
  readonly ttlMs: number;
  readonly now: () => number;
  readonly entries: Map<string, Approval<T>>;
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  prune() {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }

  issue({ sessionId, request, reasons = [] }: { sessionId: string; request: T; reasons?: string[] }) {
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

  consume(token: string, { sessionId }: { sessionId?: string } = {}) {
    this.prune();
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (!entry) {
      const error = new BrowserRuntimeError("Approval token is invalid or expired. Submit the action chain again for review.", { code: "APPROVAL_TOKEN_INVALID" });
      throw error;
    }
    if (sessionId && entry.sessionId !== String(sessionId)) {
      const error = new BrowserRuntimeError("Approval token belongs to a different browser session.", { code: "APPROVAL_SESSION_MISMATCH" });
      throw error;
    }
    return entry;
  }

  clear() {
    this.entries.clear();
  }
}
