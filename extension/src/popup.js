const status = document.querySelector("#status");
const statusDetail = document.querySelector("#status-detail");
const statusPill = document.querySelector("#status-pill");
const statusDot = document.querySelector("#status-dot");
const host = document.querySelector("#host");
const lastChecked = document.querySelector("#last-checked");
const profileId = document.querySelector("#profile-id");
const profileForm = document.querySelector("#profile-form");
const profileLabel = document.querySelector("#profile-label");
const profileHelp = document.querySelector("#profile-help");
const semanticForm = document.querySelector("#semantic-form");
const semanticEnabled = document.querySelector("#semantic-enabled");
const semanticModel = document.querySelector("#semantic-model");
const semanticModelInfo = document.querySelector("#semantic-model-info");
const semanticPrepare = document.querySelector("#semantic-prepare");
const semanticDelete = document.querySelector("#semantic-delete");
const semanticHelp = document.querySelector("#semantic-help");
const appVersion = document.querySelector("#app-version");

let semanticModels = [];
let semanticPoll = null;
let livePort = null;
let firstStatusApplied = false;

function applyNativeStatus(nativeStatus) {
  if (!nativeStatus || typeof nativeStatus !== "object") return;
  const state = nativeStatus.state ?? "unknown";
  const lastError = nativeStatus.error;

  status.textContent = lastError ? `${state}: ${lastError}` : state;
  statusDetail.textContent = lastError ? `${state}: ${lastError}` : state;
  host.textContent = nativeStatus.hostName ?? "com.opencode.browser.plugin";
  lastChecked.textContent = nativeStatus.lastChecked ? new Date(nativeStatus.lastChecked).toLocaleString() : "-";

  statusPill.classList.remove("pill-ok", "pill-warn", "pill-bad", "pill-unknown");
  if (state === "connected") statusPill.classList.add("pill-ok");
  else if (state === "reconnecting" || state === "unknown") statusPill.classList.add("pill-warn");
  else statusPill.classList.add("pill-bad");

  firstStatusApplied = true;
}

function requestStatusOnce() {
  chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      status.textContent = `Unavailable: ${error.message}`;
      statusDetail.textContent = `Unavailable: ${error.message}`;
      statusPill.classList.remove("pill-ok", "pill-warn", "pill-unknown");
      statusPill.classList.add("pill-bad");
      return;
    }
    applyNativeStatus(response?.status);
  });
}

function connectLiveStatus() {
  try {
    livePort = chrome.runtime.connect({ name: "popup-status" });
  } catch {
    requestStatusOnce();
    return;
  }

  livePort.onMessage.addListener((message) => {
    if (message?.type === "NATIVE_STATUS") applyNativeStatus(message.status);
    if (message?.type === "STATUS_SNAPSHOT") {
      applyNativeStatus(message.status);
      firstStatusApplied = true;
    }
  });

  const fallbackTimer = setTimeout(() => {
    if (!firstStatusApplied) requestStatusOnce();
  }, 800);

  livePort.onDisconnect.addListener(() => {
    clearTimeout(fallbackTimer);
    livePort = null;
    requestStatusOnce();
  });
}

connectLiveStatus();

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
  profileHelp.textContent = "Saved. Pass this profile label to the first useful browser call.";
  });
});

function selectedSemanticModel() {
  return semanticModels.find((model) => model.id === semanticModel.value) ?? semanticModels[0] ?? null;
}

function renderModelInfo(model) {
  if (!model) {
    semanticModelInfo.textContent = "No model metadata available.";
    return;
  }
  const cache = model.cache?.cached ? "cached locally" : "not cached yet";
  const reranker = model.reranker?.id ? ` Reranker: ${model.reranker.id}.` : "";
  semanticModelInfo.textContent = `${model.description} Embedding: ${model.embedding?.id ?? "n/a"}.${reranker} Benchmark: ${model.benchmark?.label ?? "quality"} ${model.benchmark?.value ?? "n/a"}. Size: ${model.parameters}, ${model.dimensions} dimensions, ${cache}.`;
}

function renderSemanticStatus(semantic) {
  const settings = semantic?.settings ?? {};
  semanticModels = Array.isArray(semantic?.models) ? semantic.models : semanticModels;
  semanticModel.replaceChildren(...semanticModels.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    return option;
  }));
  semanticEnabled.checked = settings.enabled === true;
  semanticModel.value = settings.modelId ?? semanticModels[0]?.id ?? "";
  renderModelInfo(selectedSemanticModel());

  const load = semantic?.load ?? {};
  const loadModel = semanticModels.find((model) => model.id === load.modelId) ?? selectedSemanticModel();
  const cacheDir = semantic?.cacheDir ? ` Cache: ${semantic.cacheDir}` : "";
  if (load.state === "loading") {
    const progress = Number.isFinite(load.progress) ? ` ${load.progress}%` : "";
    const component = load.component ? ` ${load.component}` : "";
    semanticHelp.textContent = `Preparing${component} for ${loadModel?.label ?? "model"}...${progress}${cacheDir}`;
    startSemanticPoll();
    return;
  }
  if (load.state === "ready") {
    semanticHelp.textContent = `Ready: ${loadModel?.label ?? load.modelId}.${cacheDir}`;
    stopSemanticPoll();
    return;
  }
  if (load.state === "error") {
    semanticHelp.textContent = `Model error: ${load.error ?? "unknown error"}.${cacheDir}`;
    stopSemanticPoll();
    return;
  }
  semanticHelp.textContent = `Snowflake retrieval is the default. Lexical and auto search remain available; download and load failures degrade safely.${cacheDir}`;
}

function loadSemanticStatus() {
  chrome.runtime.sendMessage({ type: "GET_SEMANTIC_SETTINGS" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || response?.error) {
      semanticHelp.textContent = error?.message ?? response.error;
      return;
    }
    renderSemanticStatus(response?.semantic);
  });
}

function startSemanticPoll() {
  if (semanticPoll) return;
  semanticPoll = setInterval(loadSemanticStatus, 1500);
}

function stopSemanticPoll() {
  if (!semanticPoll) return;
  clearInterval(semanticPoll);
  semanticPoll = null;
}

semanticModel.addEventListener("change", () => renderModelInfo(selectedSemanticModel()));

semanticForm.addEventListener("submit", (event) => {
  event.preventDefault();
  semanticHelp.textContent = "Saving semantic settings...";
  chrome.runtime.sendMessage({
    type: "SET_SEMANTIC_SETTINGS",
    enabled: semanticEnabled.checked,
    modelId: semanticModel.value,
    preload: semanticEnabled.checked,
  }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || response?.error) {
      semanticHelp.textContent = error?.message ?? response.error;
      return;
    }
    renderSemanticStatus(response?.semantic);
  });
});

semanticPrepare.addEventListener("click", () => {
  semanticHelp.textContent = "Starting local model preparation...";
  chrome.runtime.sendMessage({ type: "PREPARE_SEMANTIC_MODEL", modelId: semanticModel.value }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || response?.error) {
      semanticHelp.textContent = error?.message ?? response.error;
      return;
    }
    renderSemanticStatus(response?.semantic);
  });
});

semanticDelete.addEventListener("click", () => {
  const model = selectedSemanticModel();
  if (!model) return;
  const confirmed = confirm(`Delete local files for ${model.label}? They can be downloaded again later.`);
  if (!confirmed) return;
  semanticHelp.textContent = "Deleting local model files...";
  chrome.runtime.sendMessage({ type: "DELETE_SEMANTIC_MODEL", modelId: semanticModel.value }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || response?.error) {
      semanticHelp.textContent = error?.message ?? response.error;
      return;
    }
    renderSemanticStatus(response?.semantic);
  });
});

const manifest = chrome.runtime.getManifest();
if (appVersion) appVersion.textContent = `v${manifest.version}`;

loadSemanticStatus();

// ── Action Memory view ────────────────────────────────────────────────

const viewTabs = {
  connection: document.querySelector("#tab-connection"),
  memory: document.querySelector("#tab-memory"),
};
const views = {
  connection: document.querySelector("#view-connection"),
  memory: document.querySelector("#view-memory"),
};

const memoryStatePill = document.querySelector("#memory-state-pill");
const memoryStateLine = document.querySelector("#memory-state-line");
const memoryFeedback = document.querySelector("#memory-feedback");
const memorySuccess = document.querySelector("#memory-success");
const memoryActions = document.querySelector("#memory-actions");
const memoryChains = document.querySelector("#memory-chains");
const memoryNegatives = document.querySelector("#memory-negatives");
const memoryHits = document.querySelector("#memory-hits");
const memoryChart = document.querySelector("#memory-chart");
const memoryEnable = document.querySelector("#memory-enable");
const memoryPause = document.querySelector("#memory-pause");
const memoryResume = document.querySelector("#memory-resume");
const memoryDisable = document.querySelector("#memory-disable");
const quotaSlider = document.querySelector("#quota-slider");
const quotaNow = document.querySelector("#quota-now");
const quotaCaption = document.querySelector("#quota-caption");
const quotaFill = document.querySelector("#quota-fill");
const quotaUsage = document.querySelector("#quota-usage");
const powerUser = document.querySelector("#power-user");
const powerNote = document.querySelector("#power-note");
const pruneDays = document.querySelector("#purge-days");
const pruneNow = document.querySelector("#prune-now");
const exportJson = document.querySelector("#export-json");
const importJson = document.querySelector("#import-json");
const shareFeedback = document.querySelector("#share-feedback");

const MB = 1024 * 1024;
let memoryStatus = null;
let memoryBusy = false;

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setActiveView(name) {
  for (const key of ["connection", "memory"]) {
    const active = key === name;
    views[key].hidden = !active;
    viewTabs[key].classList.toggle("active", active);
    viewTabs[key].setAttribute("aria-selected", active ? "true" : "false");
  }
  if (name === "memory") void refreshMemory();
}

viewTabs.connection.addEventListener("click", () => setActiveView("connection"));
viewTabs.memory.addEventListener("click", () => setActiveView("memory"));

async function memoryCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "MEMORY_CALL", method, params }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? `${method} failed`));
        return;
      }
      resolve(response.result);
    });
  });
}

function memoryPillClass(health) {
  if (health === "ready") return "pill-ok";
  if (["disabled", "paused", "quota_reached"].includes(health)) return "pill-warn";
  return "pill-bad";
}

function memoryStateLabel(status) {
  if (status.health === "quota_reached") return "Quota reached — capture paused";
  if (!status.enabled) return "Memory is off";
  return status.paused ? "Capture paused" : "Capture is on";
}

function renderMemoryState(status) {
  memoryStatePill.textContent = memoryStateLabel(status);
  memoryStatePill.className = `pill ${memoryPillClass(status.health)}`;
  const counts = status.counts;
  memoryStateLine.textContent = status.enabled
    ? `${counts.signatures} actions, ${counts.chains} chains, ${counts.failure_contexts} negative lessons.`
    : "Enable it to start building action memory.";
  const total = counts.confirmed_total + counts.failed_total;
  const rate = total > 0 ? Math.round((counts.confirmed_total / total) * 100) : 100;
  memorySuccess.textContent = `${rate}%`;
  memoryActions.textContent = counts.signatures;
  memoryChains.textContent = counts.chains;
  memoryNegatives.textContent = counts.failure_contexts;
  memoryHits.textContent = status.memory_hits;

  memoryEnable.disabled = memoryBusy || status.enabled;
  memoryDisable.disabled = memoryBusy || !status.enabled;
  memoryPause.disabled = memoryBusy || !status.enabled || status.paused;
  memoryResume.disabled = memoryBusy || !status.enabled || !status.paused;

  const quotaMb = Number(status.quota_bytes) / MB;
  quotaSlider.value = String(Math.round(quotaMb));
  quotaNow.textContent = formatBytes(status.quota_bytes);
  quotaCaption.textContent = status.power_user
    ? `Power user mode — up to 10 GB.`
    : `Standard limit. Enable power user below to raise it.`;
  quotaSlider.disabled = memoryBusy || !status.power_user;
  powerUser.checked = status.power_user === true;
  powerNote.hidden = status.power_user !== true;
  pruneDays.value = String(status.purge_days);
  const fill = Math.min(100, (status.bytes_used / Math.max(1, Number(status.quota_bytes))) * 100);
  quotaFill.style.width = `${fill}%`;
  quotaUsage.textContent = `${formatBytes(status.bytes_used)} of ${formatBytes(status.quota_bytes)} used`;
  renderMemoryChart(status.recent_daily ?? []);
}

function renderMemoryChart(daily) {
  memoryChart.replaceChildren();
  const days = (Array.isArray(daily) ? daily : []).slice(-14);
  if (days.length === 0) return;
  const width = 320;
  const height = 64;
  const pad = 14;
  const maxValue = Math.max(1, ...days.map((day) => day.confirmed + day.failed));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad;
  const barWidth = Math.min(12, plotWidth / Math.max(1, days.length) * 0.6);
  days.forEach((day, index) => {
    const x = pad + (index / Math.max(1, days.length - 1)) * plotWidth;
    const failed = (day.failed / maxValue) * plotHeight;
    const confirmed = (day.confirmed / maxValue) * plotHeight;
    if (day.failed > 0) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x - barWidth / 2);
      rect.setAttribute("y", pad + plotHeight - failed);
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", failed);
      rect.setAttribute("fill", "#cf222e");
      rect.setAttribute("opacity", "0.7");
      svg.append(rect);
    }
    if (day.confirmed > 0) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x - barWidth / 2);
      rect.setAttribute("y", pad + plotHeight - failed - confirmed);
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", confirmed);
      rect.setAttribute("fill", "#1a7f37");
      rect.setAttribute("rx", 1);
      svg.append(rect);
    }
  });
  memoryChart.append(svg);
}

function memoryFeedbackText(text, error = false) {
  memoryFeedback.textContent = text;
  memoryFeedback.classList.toggle("feedback-error", error);
}

async function runMemoryAction(method, successText) {
  if (memoryBusy) return;
  memoryBusy = true;
  try {
    await memoryCall(method);
    memoryFeedbackText(successText);
  } catch (error) {
    memoryFeedbackText(error instanceof Error ? error.message : String(error), true);
  } finally {
    memoryBusy = false;
    await refreshMemory();
  }
}

async function refreshMemory() {
  try {
    memoryStatus = await memoryCall("memory.stats");
    renderMemoryState(memoryStatus);
  } catch (error) {
    memoryStatePill.textContent = "unavailable";
    memoryStatePill.className = "pill pill-bad";
    memoryStateLine.textContent = error instanceof Error ? error.message : String(error);
    for (const button of [memoryEnable, memoryPause, memoryResume, memoryDisable]) button.disabled = true;
  }
}

memoryEnable.addEventListener("click", () => void runMemoryAction("memory.enable", "Memory enabled — capture is on."));
memoryPause.addEventListener("click", () => void runMemoryAction("memory.pause", "Capture paused."));
memoryResume.addEventListener("click", () => void runMemoryAction("memory.resume", "Capture resumed."));
memoryDisable.addEventListener("click", () => void runMemoryAction("memory.disable", "Memory disabled — capture is off."));

quotaSlider.addEventListener("change", async () => {
  const valueMb = Number(quotaSlider.value);
  memoryBusy = true;
  quotaSlider.disabled = true;
  try {
    await memoryCall("memory.configure", { quota_bytes: valueMb * MB });
    memoryFeedbackText(`Database limit set to ${formatBytes(valueMb * MB)}.`);
  } catch (error) {
    memoryFeedbackText(error instanceof Error ? error.message : String(error), true);
  } finally {
    memoryBusy = false;
    await refreshMemory();
  }
});

powerUser.addEventListener("change", async () => {
  memoryBusy = true;
  try {
    await memoryCall("memory.configure", { power_user: powerUser.checked });
    memoryFeedbackText(powerUser.checked ? "Power user mode on — the slider now goes up to 10 GB." : "Power user mode off — back to the standard limit.");
  } catch (error) {
    memoryFeedbackText(error instanceof Error ? error.message : String(error), true);
  } finally {
    memoryBusy = false;
    await refreshMemory();
  }
});

pruneDays.addEventListener("change", async () => {
  const value = Number(pruneDays.value);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    memoryFeedbackText("Purge period must be between 1 and 365 days.", true);
    await refreshMemory();
    return;
  }
  memoryBusy = true;
  try {
    await memoryCall("memory.configure", { purge_days: value });
    memoryFeedbackText(`Negative lessons purge after ${value} days.`);
  } catch (error) {
    memoryFeedbackText(error instanceof Error ? error.message : String(error), true);
  } finally {
    memoryBusy = false;
    await refreshMemory();
  }
});

pruneNow.addEventListener("click", async () => {
  memoryBusy = true;
  try {
    const result = await memoryCall("memory.prune");
    memoryFeedbackText(`Pruned ${result.removed} aged and ${result.evicted} evicted negative lessons.`);
  } catch (error) {
    memoryFeedbackText(error instanceof Error ? error.message : String(error), true);
  } finally {
    memoryBusy = false;
    await refreshMemory();
  }
});

exportJson.addEventListener("click", async () => {
  try {
    const payload = await memoryCall("memory.export");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `action-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    shareFeedback.textContent = "Exported your memory snapshot.";
  } catch (error) {
    shareFeedback.textContent = error instanceof Error ? error.message : String(error);
  }
});

importJson.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const result = await memoryCall("memory.import", payload);
    shareFeedback.textContent = `Imported ${result.imported} signatures.`;
    await refreshMemory();
  } catch (error) {
    shareFeedback.textContent = `Import failed: ${error instanceof Error ? error.message : error}`;
  } finally {
    event.target.value = "";
  }
});