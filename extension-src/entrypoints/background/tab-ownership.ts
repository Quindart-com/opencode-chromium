export function assertTabAccess<T extends { sessionId: string }>({ owner, sessionId, tabId, allowUnowned = false }: { owner: T | null | undefined; sessionId: string; tabId: number; allowUnowned?: boolean }) {
  if (owner && owner.sessionId !== sessionId) throw new Error(`Tab ${tabId} is controlled by another session; its owner must release it before it can be claimed`);
  if (!owner && !allowUnowned) throw new Error(`Tab ${tabId} is not controlled by this session`);
  return owner;
}

export function isBrowserInternalUrl(url: string | undefined): boolean {
  return /^(chrome|chrome-untrusted|edge|brave|vivaldi|opera|chrome-extension|moz-extension|devtools|resource|view-source|javascript):/i.test(url ?? "") || (/^about:/i.test(url ?? "") && url !== "about:blank");
}

export function ownershipError(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false, uncertain: false, executionState: "not_started" });
}

export class TabOwnershipTransitions {
  private readonly tabs = new Set<number>();
  idle(tabId: number) { return !this.tabs.has(tabId); }
  assertIdle(tabId: number) {
    if (!this.idle(tabId)) throw ownershipError("TAB_OWNERSHIP_BUSY", "A tab ownership change is in progress.");
  }
  begin(tabId: number) {
    this.assertIdle(tabId);
    this.tabs.add(tabId);
    return () => this.tabs.delete(tabId);
  }
}
