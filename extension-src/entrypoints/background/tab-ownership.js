export function assertTabAccess({ owner, sessionId, tabId, allowUnowned = false }) {
  if (owner && owner.sessionId !== sessionId) throw new Error(`Tab ${tabId} is controlled by another session; its owner must release it before it can be claimed`);
  if (!owner && !allowUnowned) throw new Error(`Tab ${tabId} is not controlled by this session`);
  return owner;
}
