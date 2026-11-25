import type { Browser,WxtBrowser } from "wxt/browser";
import { browserGroupId } from "./tab-claims.ts";
import { isBrowserInternalUrl } from "./tab-ownership.ts";
import type { ExtensionSession } from "./types.ts";

export function canChangeGroup(session: ExtensionSession, tab: Browser.tabs.Tab, tabId: number) {
  const recorded = session.tabGroups?.get(tabId);
  const groupId = browserGroupId(tab);
  return recorded?.origin !== "existing" && !tab.pinned && !tab.incognito &&
    !isBrowserInternalUrl(tab.url) && !isBrowserInternalUrl(tab.pendingUrl) &&
    (groupId === null || groupId === (recorded?.id ?? session.groupId));
}

export async function assignSessionGroup(chrome: WxtBrowser, session: ExtensionSession, tab: Browser.tabs.Tab & { id: number }, color: "green") {
  if (!chrome.tabs.group || !chrome.tabGroups || tab.pinned) return;
  const existing = session.groupId === null ? null : await chrome.tabGroups.get(session.groupId).catch(() => null);
  const current = await chrome.tabs.get(tab.id);
  if (current.windowId !== tab.windowId || browserGroupId(current) !== null || !canChangeGroup(session, current, tab.id)) return;
  const reuse = existing?.windowId === tab.windowId && existing.color === color;
  const id = await chrome.tabs.group({ tabIds: [tab.id], ...(reuse ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }) });
  if (!session.tabIds.has(tab.id)) return;
  (session.tabGroups ??= new Map()).set(tab.id, { id, windowId: tab.windowId, origin: "session" });
  if (!reuse) {
    session.groupId = id;
    await chrome.tabGroups.update(id, { title: session.name ?? "OpenCode", color }).catch(() => {});
  }
}

export async function releaseSessionGroup(chrome: WxtBrowser, session: ExtensionSession, tabId: number) {
  if (!chrome.tabs.ungroup || !chrome.tabGroups || session.tabGroups?.get(tabId)?.origin === "existing") return;
  const tab = await chrome.tabs.get(tabId);
  if (browserGroupId(tab) !== null && canChangeGroup(session, tab, tabId)) await chrome.tabs.ungroup(tabId);
}
