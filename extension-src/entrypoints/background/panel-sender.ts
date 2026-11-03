import type { Browser } from "wxt/browser";

/** A same-extension content script/embedded frame is not our trusted control panel. */
export function trustedPanelSender(sender: Browser.runtime.MessageSender, extensionId: string, panelUrl: string): boolean {
  if (sender.id !== extensionId || sender.url?.split(/[?#]/)[0] !== panelUrl) return false;
  return !sender.tab || sender.frameId === 0 && sender.tab.url?.split(/[?#]/)[0] === panelUrl;
}
