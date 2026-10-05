import { z } from "zod";
import { errorMessage } from "./errors.js";

// A failure has to say what went wrong and what to try next, and little else:
// the code, a bounded message, and one actionable hint. Provider messages can be
// arbitrarily long, and the model pays for every character of them on every
// retry, so the message is clipped here rather than at each call site.

export const FAILURE_MESSAGE_LIMIT = 240;

const FAILURE_HINTS = {
  INVALID_REQUEST: "Check the step arguments with the selected profile and tab, then retry once.",
  STALE_TARGET: "Re-read the page and use a fresh nodeId, selector, or coordinates.",
  TIMEOUT: "The browser did not answer in time. Retry once, then narrow the step.",
  BROWSER_OPERATION_FAILED: "Re-read the page before retrying; do not repeat the same step unchanged.",
  APPROVAL_REQUIRED: "Review the chain, then call browser_run with only the approvalToken.",
  PROFILE_DISCONNECTED: "Reconnect the browser profile, then retry.",
  UNSUPPORTED_ACTION: "Use one of the actions listed in the tool description.",
  TAB_NOT_FOUND: "List tabs and choose an existing tabId.",
};

// Page and provider errors arrive with stack frames and newlines that the model
// cannot use. Keep the first line of the message and collapse the rest.
function condense(value) {
  return String(value ?? "")
    .split(/\n\s*at\s/)
    .shift()
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value, limit) {
  const text = condense(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function failureHint(code) {
  return FAILURE_HINTS[code] ?? FAILURE_HINTS.BROWSER_OPERATION_FAILED;
}

export function errorDetails(error) {
  const message = errorMessage(error);
  const timeout = /timed?\s*out|timeout/i.test(message);
  const disconnected = /disconnect|closed target|(?:session|connection|socket|host).+(?:closed|ended)|websocket/i.test(message);
  const validation = error instanceof z.ZodError || /requires |invalid |unsupported |must |missing/i.test(message);
  const code = String(error?.code ?? (timeout ? "TIMEOUT" : validation ? "INVALID_REQUEST" : "BROWSER_OPERATION_FAILED"));
  return {
    code,
    message: clip(message, FAILURE_MESSAGE_LIMIT),
    hint: failureHint(code),
    retryable: Boolean(error?.retryable ?? (timeout || disconnected)),
    uncertain: Boolean(error?.uncertain ?? (timeout || disconnected)),
    ...(error?.details ? { details: error.details } : {}),
  };
}
