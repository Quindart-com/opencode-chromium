import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { ExtensionSession } from "./types.ts";

export async function finalizeOwnedTabs(session: ExtensionSession, keep: Map<number, string>, dependencies: {
  dialog(tabId: number): unknown;
  blocked?(tabId: number): string | undefined;
  detach(tabId: number): Promise<unknown>;
  hide(tabId: number): Promise<unknown>;
  deliver(tabId: number): Promise<unknown>;
  ungroup(tabId: number): Promise<unknown>;
  untrack(tabId: number): Promise<unknown>;
  close(tabId: number): Promise<unknown>;
}) {
  const tabs = await Promise.all([...session.tabIds].map(async tabId => {
    const deadlineAt = Date.now() + 3500;
    const userOrigin = session.tabOrigins.get(tabId) === "user";
    const run = <T>(operation: () => Promise<T>, phase: string) => beforeDeadline(operation, deadlineAt, { tabId, phase, method: "finalize" });
    try {
      if (dependencies.blocked?.(tabId)) return { tabId, status: "blocked", reason: dependencies.blocked(tabId) };
      if (dependencies.dialog(tabId)) return { tabId, status: "blocked", reason: "native_dialog", dialog: dependencies.dialog(tabId) };
      await run(() => dependencies.detach(tabId), "detach");
      await run(() => dependencies.hide(tabId), "cursor cleanup");
      const status = keep.get(tabId);
      if (status === "handoff") return { tabId, status: "kept" };
      if (status === "deliverable") await run(() => dependencies.deliver(tabId), "deliverable");
      else if (userOrigin) await run(() => dependencies.ungroup(tabId), "release");
      else await run(() => dependencies.close(tabId), "close");
      await run(() => dependencies.untrack(tabId), "ownership cleanup");
      return { tabId, status: status === "deliverable" || userOrigin ? "released" : "closed" };
    } catch (error) { return { tabId, status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
  }));
  return { partial: tabs.some(tab => tab.status === "blocked"), tabs };
}
