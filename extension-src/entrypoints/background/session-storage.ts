import { z } from "zod/mini";
import { updateSessionPolicy } from "./navigation-policy.ts";
import type { ExtensionSession } from "./types.ts";

const key = "OPENCODE_BROWSER_SESSIONS";
const storedSession = z.object({
  name: z.optional(z.nullable(z.string())),
  urlPolicy: z.optional(z.nullable(z.object({ allowedOrigins: z.optional(z.array(z.string())), blockedOrigins: z.optional(z.array(z.string())) }))),
  groupId: z.optional(z.nullable(z.int())),
  activeTabId: z.optional(z.nullable(z.int())),
  currentTurnId: z.optional(z.nullable(z.string())),
  lastActivityAt: z.optional(z.number()),
  tabOrigins: z.optional(z.record(z.string(), z.string())),
  tabIds: z.optional(z.array(z.int())),
  tabGroups: z.optional(z.record(z.string(), z.object({ id: z.int(), windowId: z.int(), origin: z.enum(["existing", "session"]) }))),
});

export function createSessionStorage({ sessions, get, set, getTab, sessionState }: {
  sessions: Map<string, ExtensionSession>;
  get(key: string): Promise<Record<string, unknown>>;
  set(data: Record<string, unknown>): Promise<unknown>;
  getTab(tabId: number): Promise<unknown>;
  sessionState(sessionId: string): ExtensionSession;
}) {
  let writes: Promise<unknown> = Promise.resolve();
  return {
    persistSessions() {
      const serialized = Object.fromEntries([...sessions].map(([id, session]) => [id, {
        tabIds: [...session.tabIds],
        tabOrigins: Object.fromEntries(session.tabOrigins),
        tabGroups: Object.fromEntries(session.tabGroups ?? []),
        lastActivityAt: session.lastActivityAt,
        name: session.name,
        urlPolicy: session.urlPolicy ?? null,
        groupId: session.groupId,
        activeTabId: session.activeTabId,
        currentTurnId: session.currentTurnId,
      }]));
      // A slow older write must not resurrect ownership after a release.
      writes = writes.catch(() => {}).then(() => set({ [key]: serialized }));
      return writes;
    },
    async restoreSessions() {
      const stored = (await get(key))[key];
      if (!stored || typeof stored !== "object") return;
      for (const [id, value] of Object.entries(stored)) {
        const parsed = storedSession.safeParse(value);
        if (!parsed.success) continue;
        const row = parsed.data;
        const session = sessionState(id);
        session.lastActivityAt = row.lastActivityAt ?? 0;
        session.name = row.name ?? null;
        session.groupId = row.groupId ?? null;
        session.activeTabId = row.activeTabId ?? null;
        session.currentTurnId = row.currentTurnId ?? null;
        if (row.urlPolicy) updateSessionPolicy(session, { url_policy: row.urlPolicy });
        for (const tabId of row.tabIds ?? []) {
          try { await getTab(tabId); } catch { continue; }
          session.tabIds.add(tabId);
          session.tabOrigins.set(tabId, row.tabOrigins?.[tabId] === "user" ? "user" : "agent");
          const group = row.tabGroups?.[tabId];
          if (group) (session.tabGroups ??= new Map()).set(tabId, group);
        }
        if (!session.tabIds.size) sessions.delete(id);
      }
    },
  };
}
