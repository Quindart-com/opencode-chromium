export function assertTabAccess<T extends { sessionId: string }>({ owner, sessionId, tabId, allowUnowned = false }: { owner: T | null | undefined; sessionId: string; tabId: number; allowUnowned?: boolean }) {
  if (owner && owner.sessionId !== sessionId) throw new Error(`Tab ${tabId} is controlled by another session; its owner must release it before it can be claimed`);
  if (!owner && !allowUnowned) throw new Error(`Tab ${tabId} is not controlled by this session`);
  return owner;
}
