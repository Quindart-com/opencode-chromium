import type { Browser,WxtBrowser } from "wxt/browser";

export async function openInstallGuide(chrome: WxtBrowser, details: Browser.runtime.InstalledDetails) {
  const version = chrome.runtime.getManifest().version;
  if (!["install", "update"].includes(details.reason) || details.previousVersion === version) return;
  const stored = await chrome.storage.local.get(["guideVersion", "showReleaseNotes"]);
  if (stored.guideVersion === version || (details.reason === "update" && stored.showReleaseNotes === false)) return;
  const url = details.reason === "update" ? `https://quindart-com.github.io/opencode-chromium/updates/#v${encodeURIComponent(version)}` : chrome.runtime.getURL("/welcome.html?view=welcome");
  await chrome.tabs.create({ url, active: details.reason === "install" });
  await chrome.storage.local.set({ guideVersion: version });
}
