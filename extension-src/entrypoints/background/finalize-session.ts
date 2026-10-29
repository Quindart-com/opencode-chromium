import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { ExtensionSession } from "./types.ts";

export async function finalizeOwnedTabs(session: ExtensionSession, keep: Map<number, string>, dependencies: {
  dialog(tabId: number): unknown;
  blocked?(tabId: number): string | undefined;
  detach(tabId: number): Promise<unknown>;
  hide(tabId: number): Promise<unknown>;
  deliver(tabIds: number[]): Promise<unknown>;
  untrack(tabId: number): Promise<unknown>;
}) {
  const prepared = await Promise.all([...session.tabIds].map(async tabId => {
    const deadlineAt = Date.now() + 3500;
    const run = <T>(operation: () => Promise<T>, phase: string) => beforeDeadline(operation, deadlineAt, { tabId, phase, method: "finalize" });
    try {
      if (dependencies.blocked?.(tabId)) return { tabId, status: "blocked", reason: dependencies.blocked(tabId) };
      if (dependencies.dialog(tabId)) return { tabId, status: "blocked", reason: "native_dialog", dialog: dependencies.dialog(tabId) };
      await run(() => dependencies.detach(tabId), "detach");
      await run(() => dependencies.hide(tabId), "cursor cleanup");
      return { tabId, status: keep.get(tabId) === "handoff" ? "kept" : "ready" };
    } catch (error) { return { tabId, status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
  }));
  const reviewIds = prepared.filter(tab => tab.status === "ready").map(tab => tab.tabId);
  if (reviewIds.length) {
    try {
      await beforeDeadline(() => dependencies.deliver(reviewIds), Date.now() + 3500, { phase: "review group", method: "finalize" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { partial: true, tabs: prepared.map(tab => tab.status === "ready" ? { tabId: tab.tabId, status: "blocked", reason } : tab) };
    }
  }
  const tabs = await Promise.all(prepared.map(async tab => {
    if (tab.status !== "ready") return tab;
    try {
      await beforeDeadline(() => dependencies.untrack(tab.tabId), Date.now() + 3500, { tabId: tab.tabId, phase: "ownership cleanup", method: "finalize" });
      return { tabId: tab.tabId, status: "released" };
    } catch (error) { return { tabId: tab.tabId, status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
  }));
  return { partial: tabs.some(tab => tab.status === "blocked"), tabs };
}
