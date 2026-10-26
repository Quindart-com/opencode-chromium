import { record } from "../../shared/values.ts";

export async function freshSearch<P extends { observation?: unknown }, R>(capture: () => Promise<P>, rank: (page: P) => Promise<R>, state: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await capture(), ranking = await rank(page);
    const current = record(await state()), observed = record(page.observation);
    if (current.documentId === observed.documentId && current.revision === observed.revision && current.focusedRoot === observed.focusedRoot) return { page, ranking };
  }
  throw Object.assign(new Error("Page changed during search ranking. Observe it again."), { code: "STALE_OBSERVATION", uncertain: false, retryable: false, executionState: "not_started" });
}
