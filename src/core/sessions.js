export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  get(sessionId) {
    const id = String(sessionId);
    let session = this.sessions.get(id);
    if (!session) {
      session = { sessionId: id, profileId: null, activeTabId: null, ownedTabs: new Set(), createdAt: new Date().toISOString() };
      this.sessions.set(id, session);
    }
    return session;
  }

  delete(sessionId) {
    this.sessions.delete(String(sessionId));
  }

  clear() {
    this.sessions.clear();
  }
}
