export interface CommandFailure { phase: string; method?: string; tabId?: number; dialogType?: string; executionState?: "not_started" | "unknown" }

export function deadlineError(details: CommandFailure) {
  return Object.assign(new Error(`Browser command timed out during ${details.phase}${details.method ? ': ' + details.method : ''}`), {
    code: "TIMEOUT", retryable: false, uncertain: details.executionState !== "not_started", executionState: details.executionState ?? "unknown", details,
  });
}

/** Expiry never means that a dispatched browser mutation was cancelled. */
export function beforeDeadline<T>(operation: () => T | Promise<T>, deadlineAt: number, details: CommandFailure, late?: (value: T) => void): Promise<T> {
  if (deadlineAt <= Date.now()) return Promise.reject(deadlineError({ ...details, executionState: details.executionState ?? "not_started" }));
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(deadlineError(details)); }, Math.max(1, deadlineAt - Date.now()));
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); if (expired) late?.(value); else resolve(value); }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
}
