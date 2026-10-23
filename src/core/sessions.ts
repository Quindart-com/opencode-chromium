export interface BrowserSession {
  sessionId: string;
  profileId: string | null;
  activeTabId: number | null;
  ownedTabs: Set<number>;
  createdAt: string;
}

export class SessionStore {
  readonly sessions = new Map<string, BrowserSession>();

  get(sessionId: string): BrowserSession {
    const id = String(sessionId);
    let session = this.sessions.get(id);
    if (!session) {
      session = { sessionId: id, profileId: null, activeTabId: null, ownedTabs: new Set<number>(), createdAt: new Date().toISOString() };
      this.sessions.set(id, session);
    }
    return session;
  }

  delete(sessionId: string): void { this.sessions.delete(String(sessionId)); }
  clear(): void { this.sessions.clear(); }
}
