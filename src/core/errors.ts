import { z } from "zod";

export interface RuntimeErrorOptions {
  code?: string;
  retryable?: boolean;
  uncertain?: boolean;
  cause?: unknown;
  details?: unknown;
}

export class BrowserRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly details: unknown;
  constructor(message: string | undefined, { code = "BROWSER_OPERATION_FAILED", retryable = false, uncertain = false, cause, details }: RuntimeErrorOptions = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function errorProperties(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
}

export function normalizeError(error: unknown, fallbackCode = "BROWSER_OPERATION_FAILED") {
  const message = errorMessage(error);
  const properties = errorProperties(error);
  const timeout = /timed?\s*out|timeout/i.test(message);
  const disconnected = /disconnect|closed target|session.+closed|websocket/i.test(message);
  const validation = error instanceof z.ZodError || /requires |invalid |unsupported |must |missing/i.test(message);
  return {
    code: String(properties.code ?? (timeout ? "TIMEOUT" : validation ? "INVALID_REQUEST" : fallbackCode)),
    message,
    retryable: Boolean(properties.retryable ?? (timeout || disconnected)),
    uncertain: Boolean(properties.uncertain ?? (timeout || disconnected)),
    ...(properties.details ? { details: properties.details } : {}),
  };
}

export function errorResult<T extends object>(sessionId: string | null, error: unknown, extra: T = {} as T) {
  const detail = normalizeError(error);
  return {
    ok: false,
    status: detail.code.toLowerCase(),
    sessionId,
    error: detail,
    ...extra,
  };
}
