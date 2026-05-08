const status = document.querySelector("#status");
const host = document.querySelector("#host");
const lastChecked = document.querySelector("#last-checked");

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
