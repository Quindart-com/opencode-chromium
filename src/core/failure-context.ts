import { z } from "zod";
import { authorizationForError } from "../shared/authorization.ts";
import { record } from "../shared/values.ts";
import { errorMessage } from "./errors.ts";

// A failure has to say what went wrong and what to try next, and little else:
// the code, a bounded message, and one actionable hint. Provider messages can be
// arbitrarily long, and the model pays for every character of them on every
// retry, so the message is clipped here rather than at each call site.

export const FAILURE_MESSAGE_LIMIT = 240;

const FAILURE_HINTS: Record<string, string> = {
  DIALOG_OPEN: "Read events and handle the native dialog before continuing.",
  TAB_UNHEALTHY: "Read session health and events; wait for the previous command to finish before retrying.",
  FRAME_NOT_FOUND: "Discover frames again and use a current frameId.",
  FRAME_TARGET_REQUIRED: "Discover frames with frames.list and pass target.frameId.",
  INVALID_REQUEST: "Check the step arguments with the selected profile and tab, then retry once.",
  STALE_TARGET: "Re-read the page and use a fresh nodeId, selector, or coordinates.",
  TIMEOUT: "The browser did not answer in time. Check health and dialogs; the action may have run.",
  BROWSER_OPERATION_FAILED: "Re-read the page before retrying; do not repeat the same step unchanged.",
  APPROVAL_REQUIRED: "Ask Approve / Disapprove with the harness question tool; approval resumes with only approvalToken.",
  UPLOAD_CONFIRMATION_REQUIRED: "Ask the user Approve / Disapprove with the harness question tool, then resume the original upload approval flow.",
  UPLOAD_NOT_AUTHORIZED: "Ask the user whether to approve this upload. Resume its original authorization flow only after approval.",
  UPLOAD_USER_DECLINED: "The user declined the upload. Keep the prepared files and wait for a new user instruction.",
  PROFILE_DISCONNECTED: "Reconnect the browser profile, then retry.",
  UNSUPPORTED_ACTION: "Use one of the actions listed in the tool description.",
  TAB_NOT_FOUND: "List tabs and choose an existing tabId.",
};

// Page and provider errors arrive with stack frames and newlines that the model
// cannot use. Keep the first line of the message and collapse the rest.
function condense(value: unknown) {
  return (String(value ?? "").split(/\n\s*at\s/)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: unknown, limit: number) {
  const text = condense(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function failureHint(code: string) {
  return FAILURE_HINTS[code] ?? FAILURE_HINTS.BROWSER_OPERATION_FAILED;
}

// Re-reading the page costs a round trip and a slice of the model's context, so
// it is only worth it when the action may have changed something the agent
// cannot see: an uncertain outcome, a mutating action, and a named target. A
// step rejected before it ran gets nothing.
export function shouldReobservePage({ uncertain, readOnly, hasTarget }: { uncertain?: boolean; readOnly?: boolean; hasTarget?: boolean } = {}) {
  return uncertain === true && readOnly !== true && hasTarget === true;
}

export function errorDetails(error: unknown) {
  const fields = record(error);
  const message = errorMessage(error);
  const timeout = /timed?\s*out|timeout/i.test(message);
  const disconnected = /disconnect|closed target|(?:session|connection|socket|host).+(?:closed|ended)|websocket/i.test(message);
  const validation = error instanceof z.ZodError || /requires |invalid |unsupported |must |missing/i.test(message);
  const code = String(fields.code ?? (timeout ? "TIMEOUT" : validation ? "INVALID_REQUEST" : "BROWSER_OPERATION_FAILED"));
  const authorization = authorizationForError(code);
  return {
    code,
    message: clip(message, FAILURE_MESSAGE_LIMIT),
    hint: fields.recovery ? "Read recovery results from the automatic CLI doctor. If unhealthy, run opencode-chromium doctor --repair-runtime --json and repair the reported layer; inspect uncertain actions before retrying." : failureHint(code),
    retryable: Boolean(fields.retryable ?? (timeout || disconnected)),
    uncertain: Boolean(fields.uncertain ?? (timeout || disconnected)),
    ...(authorization ? { authorization } : {}),
    ...(typeof fields.executionState === "string" ? { executionState: fields.executionState } : {}),
    ...(fields.details ? { details: fields.details } : {}),
    ...(fields.recovery ? { recovery: fields.recovery } : {}),
  };
}
