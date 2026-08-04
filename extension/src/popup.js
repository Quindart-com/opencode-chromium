const status = document.querySelector("#status");
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

let semanticModels = [];
let semanticPoll = null;

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
  semanticHelp.textContent = `Lexical search is always available. Uncertain auto searches use the lightweight model when ready; download and load failures degrade safely.${cacheDir}`;
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

loadSemanticStatus();
