import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { ExtensionSession } from "./types.ts";

type Dependencies = {
  idle(): boolean;
  reserve?(tabId: number): () => void;
  dialog(tabId: number): unknown;
  detach(tabId: number): Promise<unknown>;
  hide(tabId: number): Promise<unknown>;
  ungroup(sessionId: string, tabId: number): Promise<unknown>;
  untrack(sessionId: string, tabId: number): Promise<unknown>;
};

/**
 * Release ownership left by a process that the controller has proved dead.
 * Tabs remain open; recent, busy, or dialog-blocked sessions are left alone.
 */
export async function reconcileAbandonedSessions(
  sessions: Map<string, ExtensionSession>,
  sessionIds: readonly string[],
  inactiveBefore: number,
  dependencies: Dependencies,
) {
  const requested = [...new Set(sessionIds)].slice(0, 200);
  const settledSessionIds: string[] = [], deferredSessionIds: string[] = [];
  const releasedTabs: number[] = [], blockedTabs: { tabId: number; reason: string }[] = [];
  if (!dependencies.idle()) return { settledSessionIds, deferredSessionIds: requested, releasedTabs, blockedTabs, reason: "commands_or_approvals_pending" };

  for (const sessionId of requested) {
    const session = sessions.get(sessionId);
    if (!session) { settledSessionIds.push(sessionId); continue; }
    if (session.lastActivityAt > inactiveBefore) { deferredSessionIds.push(sessionId); continue; }
    for (const tabId of [...session.tabIds]) {
      if (session.lastActivityAt > inactiveBefore) break;
      if (!session.tabIds.has(tabId)) continue;
      if (dependencies.dialog(tabId)) { blockedTabs.push({ tabId,reason: "native_dialog" }); continue; }
      const deadlineAt = Date.now() + 3500;
      let finish: (() => void) | undefined;
      try {
        finish = dependencies.reserve?.(tabId);
        await beforeDeadline(() => dependencies.detach(tabId), deadlineAt, { tabId,phase: "detach",method: "reconcile abandoned session" });
        await beforeDeadline(() => dependencies.hide(tabId), deadlineAt, { tabId,phase: "cursor cleanup",method: "reconcile abandoned session" });
        await dependencies.ungroup(sessionId, tabId);
        await dependencies.untrack(sessionId, tabId);
        releasedTabs.push(tabId);
      } catch (error) { blockedTabs.push({ tabId,reason: error instanceof Error ? error.message : String(error) }); }
      finally { finish?.(); }
    }
    if (!sessions.get(sessionId)?.tabIds.size) { sessions.delete(sessionId); settledSessionIds.push(sessionId); }
    else deferredSessionIds.push(sessionId);
  }
  return { settledSessionIds,deferredSessionIds,releasedTabs,blockedTabs };
}
