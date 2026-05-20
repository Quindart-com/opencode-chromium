const status = document.querySelector("#status");
const host = document.querySelector("#host");
const lastChecked = document.querySelector("#last-checked");
const profileId = document.querySelector("#profile-id");
const profileForm = document.querySelector("#profile-form");
const profileLabel = document.querySelector("#profile-label");
const profileHelp = document.querySelector("#profile-help");

chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" }, (response) => {
  const error = chrome.runtime.lastError;
  if (error) {
    status.textContent = `Unavailable: ${error.message}`;
    return;
  }

  const nativeStatus = response?.status ?? {};
  const state = nativeStatus.state ?? "unknown";
  const lastError = nativeStatus.error;
  status.textContent = lastError ? `${state}: ${lastError}` : state;
  host.textContent = nativeStatus.hostName ?? "com.opencode.browser";
  lastChecked.textContent = nativeStatus.lastChecked ? new Date(nativeStatus.lastChecked).toLocaleString() : "-";
});

function showProfile(profile) {
  profileId.textContent = profile?.profileId ?? "Unavailable";
  profileLabel.value = profile?.profileLabel ?? "";
}

chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (response) => {
  const error = chrome.runtime.lastError;
  if (error || response?.error) {
    profileId.textContent = error?.message ?? response.error;
    return;
  }
  showProfile(response?.profile);
});

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  profileHelp.textContent = "Saving...";
  chrome.runtime.sendMessage({ type: "SET_PROFILE_LABEL", label: profileLabel.value }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || response?.error) {
      profileHelp.textContent = error?.message ?? response.error;
      return;
    }
    showProfile(response?.profile);
    profileHelp.textContent = "Saved. Use browser_list_profiles in OpenCode to select this profile.";
  });
});
