const READ_ACTIONS = new Set([
  "find", "assert", "screenshot", "clipboardRead",
  "search", "inspect", "visual", "extract", "events", "downloads",
]);

const READ_OPERATIONS = new Set([
  "browser_page_search", "browser_page_inspect", "browser_visual_map", "browser_dom_snapshot",
  "browser_snapshot", "browser_locator_count", "browser_locator_text", "browser_console_logs",
  "browser_network_events", "browser_download_events", "browser_selected_tab", "browser_list_tabs",
  "browser_list_profiles", "browser_selected_profile", "browser_status", "browser_get_tab",
]);

const NEVER_RETRY_ACTIONS = new Set([
  "upload", "clipboardWrite", "close", "fill", "replaceText", "fillForm", "type", "press",
  "click", "doubleClick", "drag",
]);

export function isReadOnlyAction(action) {
  return READ_ACTIONS.has(action);
}

export function isReadOnlyOperation(operation) {
  return READ_OPERATIONS.has(operation);
}

export function classifyRetry({ action, operation, error } = {}) {
  if (NEVER_RETRY_ACTIONS.has(action)) return "never";
  if (isReadOnlyAction(action) || isReadOnlyOperation(operation)) return "read";
  if (error?.code === "STALE_TARGET" || /stale|detached|unknown node/i.test(error?.message ?? String(error ?? ""))) return "recoverable";
  if (error?.code === "PROFILE_DISCONNECTED") return "recoverable";
  if (error?.retryable === true && error?.uncertain !== true) return "recoverable";
  return "never";
}

export function retryLimit({ action, operation, requested, error } = {}) {
  const classification = classifyRetry({ action, operation, error });
  if (classification === "never") return 0;
  const parsed = Number.isFinite(Number(requested)) ? Math.trunc(Number(requested)) : 1;
  return Math.max(0, Math.min(3, parsed));
}

export function backoffDelay(attempt, { baseMs = 40, maxMs = 500, jitter = 0.25, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  const spread = exponential * Math.max(0, Math.min(1, jitter));
  return Math.max(0, Math.round(exponential - spread + (random() * spread * 2)));
}

export async function withRetries(operation, { retries, action, operationName, onAttempt, delay = backoffDelay, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const limit = retryLimit({ action, operation: operationName, requested: retries });
  let attempt = 0;
  let lastError;
  while (attempt <= limit) {
    attempt += 1;
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const allowed = attempt <= limit && classifyRetry({ action, operation: operationName, error }) !== "never" && error?.uncertain !== true;
      onAttempt?.({ attempt, retries: limit, error, retrying: allowed });
      if (!allowed) break;
      await sleep(delay(attempt));
    }
  }
  throw lastError;
}

export const retryPolicy = Object.freeze({
  readOnlyActions: [...READ_ACTIONS],
  readOnlyOperations: [...READ_OPERATIONS],
  neverRetryActions: [...NEVER_RETRY_ACTIONS],
  maxRetries: 3,
});
