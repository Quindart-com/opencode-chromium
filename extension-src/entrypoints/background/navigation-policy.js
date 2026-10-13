import { assertNavigationAllowed, createUrlPolicy } from "../../../src/browser/url-policy.js";

export function updateSessionPolicy(session, params) {
  if (!params.url_policy) return;
  const normalize = value => Array.isArray(value) ? value.slice(0, 64).filter(item => typeof item === "string" && item.length <= 500) : [];
  session.urlPolicy = { allowedOrigins: normalize(params.url_policy.allowedOrigins), blockedOrigins: normalize(params.url_policy.blockedOrigins) };
}

export function assertSessionUrl(session, url) {
  assertNavigationAllowed(url, session?.urlPolicy ? createUrlPolicy(session.urlPolicy) : null);
}

export function installNavigationPolicy({ chrome, findOwner, trackTab, getTab, stopLoading }) {
  const inspect = async (tabId, url) => {
    const owner = findOwner(tabId);
    if (!owner) return;
    try {
      assertSessionUrl(owner.session, url);
    } catch (error) {
      owner.session.navigationWarnings ??= [];
      owner.session.navigationWarnings.push({ tabId, code: error.code });
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
    const owner = Number.isInteger(tab.openerTabId) ? findOwner(tab.openerTabId) : null;
    if (!owner || !Number.isInteger(tab.id)) return;
    void (async () => {
      if (findOwner(tab.id)) return;
      await trackTab(owner.sessionId, tab.id, "agent");
      const current = await getTab(tab.id);
      await inspect(tab.id, current.url ?? "about:blank");
    })().catch(() => {});
  });
}
