import type { WxtBrowser } from "wxt/browser";
import { canChangeGroup } from "./session-groups.ts";
import type { ExtensionSession } from "./types.ts";

/** Reuse the session group only when every member is ready for human review. */
export async function groupReviewTabs(session: ExtensionSession, tabIds: number[], chrome: WxtBrowser) {
  const failures = new Map<number, string>();
  if (!chrome.tabs.group || !chrome.tabGroups || !tabIds.length) return failures;
  const tabs = (await Promise.all(tabIds.map(async id => {
    if (session.tabGroups?.get(id)?.origin === "existing") return null;
    try {
      const tab = await chrome.tabs.get(id);
      return session.tabIds.has(id) && canChangeGroup(session, tab, id) ? { id, windowId: tab.windowId } : null;
    } catch {
      failures.set(id, "Could not read the tab for review grouping.");
      return null;
    }
  }))).filter(tab => tab !== null);
  const reviewIds = new Set(tabs.map(tab => tab.id));
  const existing = session.groupId === null ? null : await chrome.tabGroups.get(session.groupId).catch(() => null);
  for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
    const [first, ...rest] = tabs.filter(tab => tab.windowId === windowId).map(tab => tab.id);
    if (first === undefined) continue;
    try {
      let groupId: number | undefined;
      if (existing?.windowId === windowId) {
        const members = await chrome.tabs.query({ groupId: existing.id });
        if (members.every(tab => tab.id !== undefined && reviewIds.has(tab.id))) groupId = existing.id;
      }
      const reviewGroupId = await chrome.tabs.group({ tabIds: [first, ...rest], ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
      // Retain the new group association if naming fails and finalization is retried.
      for (const id of [first, ...rest]) {
        if (session.tabIds.has(id)) (session.tabGroups ??= new Map()).set(id, { id: reviewGroupId, windowId, origin: "session" });
      }
      await chrome.tabGroups.update(reviewGroupId, { title: session.name ?? "OpenCode", color: "blue" });
    } catch {
      for (const id of [first, ...rest]) failures.set(id, "Could not group the tab for human review.");
    }
  }
  return failures;
}
