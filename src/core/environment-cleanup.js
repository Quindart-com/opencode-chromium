export async function cleanupSessionEnvironment(runtime, session) {
  const selectedProfileId = session.profileId;
  const activeTabId = session.activeTabId;
  const configuredTabs = [...session.configuredTabs.values()];
  if (!configuredTabs.length && session.environment && Object.keys(session.environment).length && activeTabId) {
    configuredTabs.push({ tabId: activeTabId, profileId: selectedProfileId });
  }
  try {
    const ownedTabsByProfile = new Map();
    for (const configured of configuredTabs) {
      if (session.profileId !== configured.profileId) await runtime.selectProfile(session, configured.profileId);
      if (!ownedTabsByProfile.has(configured.profileId)) {
        const owned = await runtime.invoke("browser_list_tabs", { scope: "session" }, session.sessionId);
        if (!Array.isArray(owned?.tabs)) throw new Error("Cannot verify configured tab ownership for cleanup");
        ownedTabsByProfile.set(configured.profileId, new Set(owned.tabs.map(tab => tab.id ?? tab.tabId)));
      }
      // Closed or released tabs no longer belong to this session. Never attach
      // to a replacement or another agent's tab merely to reset its settings.
      if (!ownedTabsByProfile.get(configured.profileId).has(configured.tabId)) {
        session.configuredTabs.delete(`${configured.profileId}:${configured.tabId}`);
        continue;
      }
      await runtime.invoke("browser_configure", { tabId: configured.tabId, environment: { reset: true } }, session.sessionId);
      session.configuredTabs.delete(`${configured.profileId}:${configured.tabId}`);
    }
    session.environment = {};
  } finally {
    if (session.profileId !== selectedProfileId) await runtime.selectProfile(session, selectedProfileId);
    session.activeTabId = activeTabId;
  }
}
