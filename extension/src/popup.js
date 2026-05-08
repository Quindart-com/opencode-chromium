const status = document.querySelector("#status");

chrome.runtime.sendMessage({ type: "GET_HOST_STATUS" }, (response) => {
  const error = chrome.runtime.lastError;
  if (error) {
    status.textContent = `Unavailable: ${error.message}`;
    return;
  }

  const state = response?.status?.state ?? "unknown";
  const lastError = response?.status?.error;
  status.textContent = lastError ? `${state}: ${lastError}` : `Native host: ${state}`;
});
