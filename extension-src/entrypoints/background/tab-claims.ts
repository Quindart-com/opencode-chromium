import type { Browser } from "wxt/browser";
import { createUrlPolicy,type UrlPolicyConfig } from "../../../src/browser/url-policy.ts";
import type { CommandParams } from "./command-schema.ts";
import { isBrowserInternalUrl,ownershipError,type TabOwnershipTransitions } from "./tab-ownership.ts";
import type { TabOwner } from "./types.ts";

const MAX_PENDING_CLAIMS = 128;
const CLAIM_TTL_MS = 5 * 60 * 1000;
export const browserGroupId = (tab: Pick<Browser.tabs.Tab, "groupId">) =>
  typeof tab.groupId === "number" && tab.groupId >= 0 ? tab.groupId : null;

const failures = {
  TAB_NOT_FOUND: "The selected tab is no longer available.",
  TAB_CLAIM_RESTRICTED: "The selected tab is private, internal, or has no accessible URL.",
  TAB_ALREADY_OWNED: "The selected tab is controlled by a session. Wait for its release or controller reconciliation.",
  TAB_OWNERSHIP_BUSY: "The selected tab is busy. Wait for its commands or cleanup to finish.",
  TAB_CLAIM_CHANGED: "The selected tab moved or navigated during approval. Discover it again before requesting approval.",
  URL_POLICY_BLOCKED: "The selected tab is outside this session's URL policy.",
} as const;

type Eligibility = { code: keyof typeof failures } | { reason: "ungrouped" | "grouped" };

function claimEligibility(tab: Browser.tabs.Tab, owner: TabOwner | null, idle: boolean, policy: ReturnType<typeof createUrlPolicy>): Eligibility {
  const { url, pendingUrl } = tab;
  if (!tab.id || tab.id < 0) return { code: "TAB_NOT_FOUND" } as const;
  if (tab.incognito || !url || isBrowserInternalUrl(url) || isBrowserInternalUrl(pendingUrl)) return { code: "TAB_CLAIM_RESTRICTED" } as const;
  if (owner) return { code: "TAB_ALREADY_OWNED" } as const;
  if (!idle) return { code: "TAB_OWNERSHIP_BUSY" } as const;
  if (pendingUrl && pendingUrl !== url) return { code: "TAB_CLAIM_CHANGED" } as const;
  if (!policy.evaluate(url).allowed) return { code: "URL_POLICY_BLOCKED" } as const;
  return { reason: browserGroupId(tab) === null ? "ungrouped" : "grouped" } as const;
}

type ClaimIdentity = { profileId: string; sessionId: string; tabId: number };
type Ticket = ClaimIdentity & { url: string; windowId: number; groupId: number | null; expiresAt: number };
const ticketError = () => ownershipError("TAB_CLAIM_APPROVAL_INVALID", "The tab approval expired, changed, or belongs to another profile, tab, or session.");

export function createTabClaims({ getTab, queryTabs, findTabOwner, profileId, sessionId, tabId, policy, normalizeTab, track, transitions, idle, now = Date.now }: {
  getTab(id: number): Promise<Browser.tabs.Tab>;
  queryTabs(): Promise<Browser.tabs.Tab[]>;
  findTabOwner(id: number): TabOwner | null;
  profileId(): Promise<string>;
  sessionId(params: CommandParams): string;
  tabId(params: CommandParams): number;
  policy(params: CommandParams): UrlPolicyConfig;
  normalizeTab(tab: Browser.tabs.Tab): object;
  track(params: CommandParams, tab: Browser.tabs.Tab & { id: number }): Promise<unknown>;
  transitions: TabOwnershipTransitions;
  idle(id: number): boolean;
  now?(): number;
}) {
  const pending = new Map<string, Ticket>();
  const invalidate = (id: number) => {
    for (const [token, ticket] of pending) if (ticket.tabId === id) pending.delete(token);
  };
  const activeTicket = (token: string | undefined, identity: ClaimIdentity) => {
    const ticket = token ? pending.get(token) : undefined;
    if (!ticket || ticket.expiresAt <= now() || ticket.profileId !== identity.profileId ||
      ticket.sessionId !== identity.sessionId || ticket.tabId !== identity.tabId) throw ticketError();
    return ticket;
  };
  const identify = async (params: CommandParams): Promise<ClaimIdentity> => {
    const id = await profileId();
    if (params.profile_id !== id) throw ownershipError("TAB_CLAIM_PROFILE_MISMATCH", "The tab claim must name this exact browser profile.");
    return { profileId: id, sessionId: sessionId(params), tabId: tabId(params) };
  };
  const eligibility = (tab: Browser.tabs.Tab, urlPolicy: ReturnType<typeof createUrlPolicy>) => {
    const id = tab.id ?? -1;
    return claimEligibility(tab, findTabOwner(id), transitions.idle(id) && idle(id), urlPolicy);
  };
  const getTarget = (id: number) => getTab(id).catch(() => { throw ownershipError("TAB_NOT_FOUND", failures.TAB_NOT_FOUND); });
  const assertEligible = (tab: Browser.tabs.Tab, params: CommandParams) => {
    const result = eligibility(tab, createUrlPolicy(policy(params)));
    if ("code" in result) throw ownershipError(result.code, failures[result.code]);
    return result;
  };
  return {
    async list(params: CommandParams) {
      const urlPolicy = createUrlPolicy(policy(params));
      const tabs = (await queryTabs()).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
      const result = [];
      for (const tab of tabs) {
        const eligible = eligibility(tab, urlPolicy);
        if ("code" in eligible) continue;
        result.push({ ...normalizeTab(tab), tabGroup: browserGroupId(tab), claimable: true, claimReason: eligible.reason });
        if (result.length === 1000) break;
      }
      return { tabs: result };
    },
    async prepare(params: CommandParams) {
      const identity = await identify(params);
      const tab = await getTarget(identity.tabId);
      const eligible = assertEligible(tab, params);
      for (const [token, ticket] of pending) if (ticket.expiresAt <= now()) pending.delete(token);
      if (pending.size >= MAX_PENDING_CLAIMS) throw ownershipError("TAB_OWNERSHIP_BUSY", "Too many tab approvals are pending.");
      const claimToken = crypto.randomUUID(), expiresAt = now() + CLAIM_TTL_MS;
      const groupId = browserGroupId(tab);
      pending.set(claimToken, { ...identity, url: tab.url!, windowId: tab.windowId, groupId, expiresAt });
      return { claimToken, expiresAt, tab: { id: identity.tabId, title: (tab.title ?? "").slice(0, 160), url: tab.url!.slice(0, 512), tabGroup: groupId, claimReason: eligible.reason } };
    },
    async claim(params: CommandParams) {
      const identity = await identify(params);
      if (!params.claimToken) throw ownershipError("TAB_CLAIM_APPROVAL_REQUIRED", "Request approval for this existing tab before claiming it.");
      const ticket = activeTicket(params.claimToken, identity);
      const tab = await getTarget(identity.tabId);
      activeTicket(params.claimToken, identity);
      pending.delete(params.claimToken);
      if (params.deadlineAt !== undefined && params.deadlineAt <= now()) throw ticketError();
      assertEligible(tab, params);
      if (ticket.url !== tab.url || ticket.windowId !== tab.windowId || ticket.groupId !== browserGroupId(tab)) {
        throw ownershipError("TAB_CLAIM_CHANGED", failures.TAB_CLAIM_CHANGED);
      }
      // No await between checking the owner and reserving this tab.
      const finish = transitions.begin(identity.tabId);
      try {
        invalidate(identity.tabId);
        await track(params, { ...tab, id: identity.tabId });
        if (findTabOwner(identity.tabId)?.sessionId !== identity.sessionId) throw ownershipError("TAB_NOT_FOUND", failures.TAB_NOT_FOUND);
        return { ...normalizeTab(tab), origin: "user", selected: true };
      } finally { finish(); }
    },
    async decline(params: CommandParams) {
      const identity = await identify(params);
      activeTicket(params.claimToken, identity);
      pending.delete(params.claimToken!);
      return { declined: true };
    },
    invalidateSession(id: string) {
      for (const [token, ticket] of pending) if (ticket.sessionId === id) pending.delete(token);
    },
    invalidate,
  };
}
