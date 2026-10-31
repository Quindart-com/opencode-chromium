import { beforeDeadline } from "../shared/deadline.ts";
import type { RuntimePort } from "./runtime-port.ts";
import type { RuntimeSession } from "./runtime-types.ts";
export async function cleanupSessionEnvironment(runtime: RuntimePort, session: RuntimeSession) {
  const selectedProfileId = session.profileId;
  const activeTabId = session.activeTabId;
  const configuredTabs = [...session.configuredTabs.values()];
  if (!configuredTabs.length && session.environment && Object.keys(session.environment).length && activeTabId) {
    configuredTabs.push({ tabId: activeTabId, profileId: selectedProfileId });
  }
  const failed: { tabId: number; profileId: string | null; reason: string }[] = [];
  try {
    for (const profileId of new Set(configuredTabs.map(tab => tab.profileId))) {
      const group = configuredTabs.filter(tab => tab.profileId === profileId);
      try {
        if (session.profileId !== profileId) await runtime.selectProfile(session, profileId);
        const owned = await runtime.invoke("browser_list_tabs", { scope: "session" }, session.sessionId);
        if (!Array.isArray(owned?.tabs)) throw new Error("Cannot verify configured tab ownership for cleanup");
        const ownedTabs = new Set(owned.tabs.map(tab => tab.id ?? tab.tabId));
        await Promise.all(group.map(async configured => {
          try {
            // Released or closed tabs must never be reclaimed for a reset.
            if (ownedTabs.has(configured.tabId)) {
              const deadlineAt = Date.now() + 2000;
              await beforeDeadline(() => runtime.operationScope.run({ deadlineAt }, () => runtime.invoke("browser_configure", { tabId: configured.tabId, environment: { reset: true } }, session.sessionId)), deadlineAt + 500, { tabId: configured.tabId, phase: "environment cleanup" });
            }
            session.configuredTabs.delete(`${profileId}:${configured.tabId}`);
          } catch (error) { failed.push({ ...configured, reason: error instanceof Error ? error.message : String(error) }); }
        }));
      } catch (error) {
        failed.push(...group.map(tab => ({ ...tab, reason: error instanceof Error ? error.message : String(error) })));
      }
    }
    if (!failed.length) session.environment = {};
  } finally {
    if (session.profileId !== selectedProfileId) await runtime.selectProfile(session, selectedProfileId);
    session.activeTabId = activeTabId;
  }
  return failed;
}
