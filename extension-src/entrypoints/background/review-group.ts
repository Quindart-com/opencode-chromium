import type { WxtBrowser } from "wxt/browser";
import type { ExtensionSession } from "./types.ts";

/** Reuse the session group only when every member is ready for human review. */
export async function groupReviewTabs(session: ExtensionSession, tabIds: number[], chrome: WxtBrowser) {
  if (!chrome.tabs.group || !chrome.tabGroups || !tabIds.length) return;
  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id)));
  const reviewIds = new Set(tabIds);
  const existing = session.groupId === null ? null : await chrome.tabGroups.get(session.groupId).catch(() => null);
  for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
    const [first, ...rest] = tabs.filter(tab => tab.windowId === windowId).map(tab => tab.id!);
    if (first === undefined) continue;
    let groupId: number | undefined;
    if (existing?.windowId === windowId) {
      const members = await chrome.tabs.query({ groupId: existing.id });
      if (members.every(tab => tab.id !== undefined && reviewIds.has(tab.id))) groupId = existing.id;
    }
    const reviewGroupId = await chrome.tabs.group({ tabIds: [first, ...rest], ...(groupId === undefined ? {} : { groupId }) });
    await chrome.tabGroups.update(reviewGroupId, { title: session.name ?? "OpenCode", color: "blue" });
  }
}
