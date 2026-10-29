export function assertTabAccess<T extends { sessionId: string }>({ owner, sessionId, tabId, allowUnowned = false }: { owner: T | null | undefined; sessionId: string; tabId: number; allowUnowned?: boolean }) {
  if (owner && owner.sessionId !== sessionId) throw new Error(`Tab ${tabId} is controlled by another session; its owner must release it before it can be claimed`);
  if (!owner && !allowUnowned) throw new Error(`Tab ${tabId} is not controlled by this session`);
  return owner;
}

export function isBrowserInternalUrl(url: string | undefined): boolean {
  return /^(chrome|edge|brave|vivaldi|opera|chrome-extension|moz-extension):/i.test(url ?? "") || (/^about:/i.test(url ?? "") && url !== "about:blank");
}

type ClaimableTab = { id?: number; groupId?: number; url?: string };

export function isClaimableTab(tab: ClaimableTab, owner: unknown) {
  return tab.id !== undefined && !owner && !(typeof tab.groupId === "number" && tab.groupId >= 0) && !isBrowserInternalUrl(tab.url);
}

export function assertClaimableTab(tab: ClaimableTab, owner: unknown) {
  if (owner) throw new Error(`Tab ${tab.id} is already controlled by a session; its owner must release it before it can be claimed`);
  if (typeof tab.groupId === "number" && tab.groupId >= 0) throw new Error(`Tab ${tab.id} belongs to a tab group; only ungrouped, unclaimed tabs can be claimed`);
  if (isBrowserInternalUrl(tab.url)) throw new Error(`Cannot claim internal browser tab: ${tab.url}`);
}
