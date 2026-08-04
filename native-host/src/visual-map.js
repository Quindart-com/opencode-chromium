import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const SETTINGS_VERSION = 1;
const DEFAULT_MODEL_ID = "grounding-dino-tiny";
const MODEL_CACHE_ENV = "OPENCODE_BROWSER_VISUAL_DIR";

export const VISUAL_MODELS = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Grounding DINO Tiny ONNX",
    description: "Optional local zero-shot UI box detector for screenshots. DOM mapping remains the default fast path.",
    task: "zero-shot-object-detection",
    model: "onnx-community/grounding-dino-tiny-ONNX",
    dtype: "q8",
    device: "wasm",
    defaultLabels: ["button", "text field", "input", "checkbox", "menu item", "tab", "dialog", "icon button"],
  },
];

const detectors = new Map();
let settingsCache = null;
let settingsCachePath = null;

const loadState = {
  state: "idle",
  modelId: null,
  startedAt: null,
  completedAt: null,
  error: null,
};

function appDataDir() {
  const configured = process.env.AGENT_BROWSER_VISUAL_DIR ?? process.env[MODEL_CACHE_ENV];
  if (configured) return path.resolve(configured);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenCodeBrowser", "visual");
  }
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "opencode-browser", "visual");
  return path.join(os.homedir(), ".cache", "opencode-browser", "visual");
}

export function visualDataDir() {
  return appDataDir();
}

function modelCacheDir() {
  return path.join(visualDataDir(), "models");
}

function settingsPath() {
  return path.join(visualDataDir(), "settings.json");
}

function ensureVisualDirs() {
  fs.mkdirSync(modelCacheDir(), { recursive: true });
}

function configureTransformersCache() {
  ensureVisualDirs();
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
}

function modelById(modelId) {
  return VISUAL_MODELS.find((model) => model.id === modelId) ?? VISUAL_MODELS[0];
}

function normalizeSettings(value = {}) {
  const model = modelById(value.modelId);
  return {
    version: SETTINGS_VERSION,
    enabled: value.enabled === true,
    modelId: model.id,
    threshold: Number.isFinite(value.threshold) ? Math.max(0.05, Math.min(0.95, value.threshold)) : 0.25,
  };
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureVisualDirs();
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

export function getVisualSettings() {
  const filePath = settingsPath();
  if (!settingsCache || settingsCachePath !== filePath) {
    settingsCache = normalizeSettings(readJsonIfPresent(filePath) ?? {});
    settingsCachePath = filePath;
  }
  return settingsCache;
}

export function setVisualSettings(input = {}) {
  const next = normalizeSettings({ ...getVisualSettings(), ...input });
  settingsCache = next;
  settingsCachePath = settingsPath();
  writeJsonAtomic(settingsCachePath, next);
  return visualStatus();
}

function cachePathForModelId(modelId) {
  return path.join(modelCacheDir(), ...modelId.split("/"));
}

function visualModelsStatus() {
  return VISUAL_MODELS.map((model) => ({
    ...model,
    cache: {
      cached: fs.existsSync(cachePathForModelId(model.model)),
      path: cachePathForModelId(model.model),
    },
  }));
}

export function visualStatus() {
  return {
    settings: getVisualSettings(),
    models: visualModelsStatus(),
    cacheDir: modelCacheDir(),
    load: { ...loadState },
  };
}

async function loadDetector(model) {
  if (detectors.has(model.id)) return detectors.get(model.id);
  configureTransformersCache();
  Object.assign(loadState, {
    state: "loading",
    modelId: model.id,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  });
  try {
    const detector = await pipeline(model.task, model.model, { dtype: model.dtype });
    detectors.set(model.id, detector);
    Object.assign(loadState, { state: "ready", completedAt: new Date().toISOString(), error: null });
    return detector;
  } catch (error) {
    Object.assign(loadState, {
      state: "error",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function dataUrlFromImage(input = {}) {
  const mimeType = typeof input.mimeType === "string" ? input.mimeType : "image/png";
  const base64 = typeof input.imageBase64 === "string" ? input.imageBase64 : "";
  if (!base64) throw new Error("visual.mapScreenshot requires imageBase64");
  return `data:${mimeType};base64,${base64}`;
}

function compactString(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeBox(box) {
  if (Array.isArray(box) && box.length >= 4) {
    const [xmin, ymin, xmax, ymax] = box.map(Number);
    return {
      x: Math.round(xmin),
      y: Math.round(ymin),
      width: Math.max(1, Math.round(xmax - xmin)),
      height: Math.max(1, Math.round(ymax - ymin)),
    };
  }
  const x = Number(box?.xmin ?? box?.x ?? box?.left ?? 0);
  const y = Number(box?.ymin ?? box?.y ?? box?.top ?? 0);
  const xmax = Number(box?.xmax ?? box?.right ?? x + Number(box?.width ?? 1));
  const ymax = Number(box?.ymax ?? box?.bottom ?? y + Number(box?.height ?? 1));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(xmax - x)),
    height: Math.max(1, Math.round(ymax - y)),
  };
}

function normalizeDetection(detection, index) {
  const label = compactString(detection.label ?? detection.class ?? detection.name ?? `visual-${index + 1}`);
  return {
    node_id: null,
    kind: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "visual",
    label,
    box: normalizeBox(detection.box ?? detection),
    source: "visual",
    score: Number.isFinite(detection.score) ? Number(detection.score.toFixed(4)) : null,
  };
}

async function mapScreenshotLocal(input = {}) {
  const settings = getVisualSettings();
  const force = input.force === true;
  if (!settings.enabled && !force) {
    return { enabled: false, used: false, elements: [] };
  }

  const model = modelById(input.modelId ?? settings.modelId);
  const detector = await loadDetector(model);
  const labels = Array.isArray(input.labels) && input.labels.length
    ? input.labels.map((label) => compactString(label, 80)).filter(Boolean)
    : model.defaultLabels;
  const threshold = Number.isFinite(input.threshold) ? input.threshold : settings.threshold;
  const maxResults = Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 80) : 20;

  let detections;
  try {
    detections = await detector(dataUrlFromImage(input), labels, { threshold });
  } catch {
    detections = await detector(dataUrlFromImage(input), { candidate_labels: labels, threshold });
  }

  const raw = Array.isArray(detections) ? detections : detections?.results ?? [];
  return {
    enabled: settings.enabled,
    used: true,
    model: { id: model.id, label: model.label },
    elements: raw.slice(0, maxResults).map(normalizeDetection),
  };
}

export async function handleVisualHostMethod(method, params = {}) {
  if (method === "visual.status") return visualStatus();
  if (method === "visual.listModels") return { models: visualModelsStatus(), settings: getVisualSettings(), cacheDir: modelCacheDir() };
  if (method === "visual.setSettings") return setVisualSettings(params);
  if (method === "visual.mapScreenshot") return mapScreenshotLocal(params);
  return undefined;
}
