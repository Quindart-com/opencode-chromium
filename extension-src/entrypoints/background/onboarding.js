export async function openInstallGuide(chrome, details) {
  const version = chrome.runtime.getManifest().version;
  if (!["install", "update"].includes(details.reason) || details.previousVersion === version) return;
  const stored = await chrome.storage.local.get(["guideVersion", "showReleaseNotes"]);
  if (stored.guideVersion === version || (details.reason === "update" && stored.showReleaseNotes === false)) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL(`welcome.html?view=${details.reason === "update" ? "updated" : "welcome"}`), active: details.reason === "install" });
  await chrome.storage.local.set({ guideVersion: version });
}
