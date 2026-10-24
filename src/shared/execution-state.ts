import { record } from "./values.ts";

/** A later preflight rejection cannot undo earlier commands in the same action. */
export function partialDispatchError(error: unknown, completedCommands: number) {
  if (!completedCommands) return error;
  const fields = record(error);
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
    code: fields.code ?? "BROWSER_OPERATION_FAILED", retryable: false, uncertain: true, executionState: "unknown",
    details: { ...record(fields.details), completedCommands },
  });
}
