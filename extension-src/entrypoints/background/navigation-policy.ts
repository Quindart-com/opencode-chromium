import type { Browser,WxtBrowser } from "wxt/browser";
import { assertNavigationAllowed,createUrlPolicy,UrlPolicyError } from "../../../src/browser/url-policy.ts";
import type { ExtensionSession,TabOwner } from "./types.ts";

export function updateSessionPolicy(session: ExtensionSession, params: { url_policy?: { allowedOrigins?: unknown; blockedOrigins?: unknown } }) {
  if (!params.url_policy) return;
  const normalize = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 64).filter((item): item is string => typeof item === "string" && item.length <= 500) : [];
  session.urlPolicy = { allowedOrigins: normalize(params.url_policy.allowedOrigins), blockedOrigins: normalize(params.url_policy.blockedOrigins) };
}

export function assertSessionUrl(session: Pick<ExtensionSession, "urlPolicy"> | null | undefined, url: string) {
  assertNavigationAllowed(url, session?.urlPolicy ? createUrlPolicy(session.urlPolicy) : null);
}

export function installNavigationPolicy({ chrome, findOwner, trackTab, getTab, stopLoading }: {
  chrome: WxtBrowser;
  findOwner(tabId: number): TabOwner | null;
  trackTab(sessionId: string, tabId: number, origin: string): Promise<unknown>;
  getTab(tabId: number): Promise<Browser.tabs.Tab>;
  stopLoading(tabId: number): Promise<unknown>;
}) {
  const inspect = async (tabId: number, url: string) => {
    const owner = findOwner(tabId);
    if (!owner) return;
    try {
      assertSessionUrl(owner.session, url);
    } catch (error) {
      owner.session.navigationWarnings ??= [];
      owner.session.navigationWarnings.push({ tabId, code: error instanceof UrlPolicyError ? error.code : "URL_POLICY_BLOCKED" });
      owner.session.navigationWarnings = owner.session.navigationWarnings.slice(-20);
      await stopLoading(tabId).catch(() => {});
      // The policy guards subsequent automation. This detects navigation after
      // the browser starts it; it is not a network containment mechanism.
    }
  };
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    if (typeof changes.url === "string") void inspect(tabId, changes.url);
  });
  chrome.tabs.onCreated.addListener(tab => {
    const owner = tab.openerTabId !== undefined && Number.isInteger(tab.openerTabId) ? findOwner(tab.openerTabId) : null;
    const tabId = tab.id;
    if (!owner || tabId === undefined || !Number.isInteger(tabId)) return;
    void (async () => {
      if (findOwner(tabId)) return;
      await trackTab(owner.sessionId, tabId, "agent");
      const current = await getTab(tabId);
      await inspect(tabId, current.url ?? "about:blank");
    })().catch(() => {});
  });
}
