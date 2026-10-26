import { record } from "./values.ts";

/** Page exceptions cross CDP/BiDi as text; retain bounded structured diagnostics. */
export function pageException(input: unknown) {
  const value = record(input);
  const description = String(record(value.exception).description ?? value.text ?? "Page evaluation failed");
  const code = /\[([A-Z_]+)\]/.exec(description)?.[1];
  let details: unknown;
  const serialized = /\[DETAILS\](\{[^\n]*\})/.exec(description)?.[1];
  if (serialized && serialized.length <= 4000) { try { details = JSON.parse(serialized) as unknown; } catch { /* Ignore malformed page diagnostics. */ } }
  return Object.assign(new Error(description.split("\n")[0]), code ? { code, executionState: "not_started", uncertain: false, retryable: false, ...(details ? { details } : {}) } : {});
}
