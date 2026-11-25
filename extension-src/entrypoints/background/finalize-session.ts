import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { ExtensionSession } from "./types.ts";

export async function finalizeOwnedTabs(session: ExtensionSession, keep: Map<number, string>, dependencies: {
  dialog(tabId: number): unknown;
  reserve?(tabId: number): () => void;
  blocked?(tabId: number): string | undefined;
  detach(tabId: number): Promise<unknown>;
  hide(tabId: number): Promise<unknown>;
  deliver(tabIds: number[]): Promise<ReadonlyMap<number, string> | void>;
  untrack(tabId: number): Promise<unknown>;
}) {
  const reservations = new Map<number, () => void>();
  try {
    const prepared = await Promise.all([...session.tabIds].map(async tabId => {
      const deadlineAt = Date.now() + 3500;
      const run = <T>(operation: () => Promise<T>, phase: string) => beforeDeadline(operation, deadlineAt, { tabId, phase, method: "finalize" });
      try {
        const blocked = dependencies.blocked?.(tabId), dialog = dependencies.dialog(tabId);
        if (blocked) return { tabId, status: "blocked", reason: blocked };
        if (dialog) return { tabId, status: "blocked", reason: "native_dialog", dialog };
        if (dependencies.reserve) reservations.set(tabId, dependencies.reserve(tabId));
        await run(() => dependencies.detach(tabId), "detach");
        await run(() => dependencies.hide(tabId), "cursor cleanup");
        return { tabId, status: keep.get(tabId) === "handoff" ? "kept" : "ready" };
      } catch (error) { return { tabId, status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
    }));
    const reviewIds = prepared.filter(tab => tab.status === "ready").map(tab => tab.tabId);
    let reviewFailures: ReadonlyMap<number, string> | void;
    if (reviewIds.length) {
      try {
        reviewFailures = await dependencies.deliver(reviewIds);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { partial: true, tabs: prepared.map(tab => tab.status === "ready" ? { tabId: tab.tabId, status: "blocked", reason } : tab) };
      }
    }
    const tabs = await Promise.all(prepared.map(async tab => {
      if (tab.status !== "ready") return tab;
      const reason = reviewFailures?.get(tab.tabId);
      if (reason) return { tabId: tab.tabId, status: "blocked", reason };
      try {
        await dependencies.untrack(tab.tabId);
        return { tabId: tab.tabId, status: "released" };
      } catch (error) { return { tabId: tab.tabId, status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
    }));
    return { partial: tabs.some(tab => tab.status === "blocked"), tabs };
  } finally {
    for (const release of reservations.values()) release();
  }
}
