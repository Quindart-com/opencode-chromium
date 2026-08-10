import { z } from "zod";

export class BrowserRuntimeError extends Error {
  constructor(message, { code = "BROWSER_OPERATION_FAILED", retryable = false, uncertain = false, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.details = details;
  }
}

export function errorMessage(error) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function normalizeError(error, fallbackCode = "BROWSER_OPERATION_FAILED") {
  const message = errorMessage(error);
  const timeout = /timed?\s*out|timeout/i.test(message);
  const disconnected = /disconnect|closed target|session.+closed|websocket/i.test(message);
  const validation = error instanceof z.ZodError || /requires |invalid |unsupported |must |missing/i.test(message);
  return {
    code: String(error?.code ?? (timeout ? "TIMEOUT" : validation ? "INVALID_REQUEST" : fallbackCode)),
    message,
    retryable: Boolean(error?.retryable ?? timeout ?? disconnected),
    uncertain: Boolean(error?.uncertain ?? timeout ?? disconnected),
    ...(error?.details ? { details: error.details } : {}),
  };
}

export function errorResult(sessionId, error, extra = {}) {
  const detail = normalizeError(error);
  return {
    ok: false,
    status: detail.code.toLowerCase(),
    sessionId,
    error: detail,
    ...extra,
  };
}
