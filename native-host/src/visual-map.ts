import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readJsonIfPresent } from "../../src/shared/node-files.ts";
import { record } from "../../src/shared/values.ts";
import { localModelCatalog,mergeModelCatalog,type VisualModel } from "./model-catalog.ts";

const visualInputSchema = z.object({ force: z.boolean().optional(), modelId: z.string().optional(), labels: z.array(z.string()).max(80).optional(), threshold: z.number().optional(), maxResults: z.number().optional(), mimeType: z.string().optional(), imageBase64: z.string().max(4_000_000).optional() });
type VisualInput = z.infer<typeof visualInputSchema>;
const SETTINGS_VERSION = 1;
const DEFAULT_MODEL_ID = "grounding-dino-tiny";
const MODEL_CACHE_ENV = "OPENCODE_BROWSER_VISUAL_DIR";

export const VISUAL_MODELS: VisualModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Grounding DINO Tiny ONNX",
    description: "Optional local zero-shot UI box detector for screenshots. DOM mapping remains the default fast path.",
    task: "zero-shot-object-detection" as const,
    model: "onnx-community/grounding-dino-tiny-ONNX",
    dtype: "q8" as const,
    device: "wasm",
    defaultLabels: ["button", "text field", "input", "checkbox", "menu item", "tab", "dialog", "icon button"],
  },
];

type Detector = (image: string, labels: string[], options: { threshold: number }) => Promise<unknown>;
const detectors = new Map<string, Detector>();
let settingsCache: { version: number; enabled: boolean; modelId: string; threshold: number; }|null = null;
let settingsCachePath: string|null = null;

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

async function configureTransformersCache() {
  const runtime = await import("@huggingface/transformers");
  const { env } = runtime;
  ensureVisualDirs();
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  return runtime;
}

function modelById(modelId: string | undefined) {
  const models = mergeModelCatalog(VISUAL_MODELS, localModelCatalog().visual);
  const model = models.find(model => model.id === modelId) ?? models[0];
  if (!model) throw new Error("No visual models are configured");
  return model;
}

function normalizeSettings(input: unknown = {}) {
  const value = record(input);
  const model = modelById(typeof value.modelId === "string" ? value.modelId : undefined);
  return {
    version: SETTINGS_VERSION,
    enabled: value.enabled === true,
    modelId: model.id,
    threshold: typeof value.threshold === "number" && Number.isFinite(value.threshold) ? Math.max(0.05, Math.min(0.95, value.threshold)) : 0.25,
  };
}

function writeJsonAtomic(filePath: fs.PathLike, value: { version: number; enabled: boolean; modelId: string; threshold: number; }) {
  ensureVisualDirs();
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

export function getVisualSettings() {
  const filePath = settingsPath();
  settingsCache = normalizeSettings(readJsonIfPresent(filePath) ?? {});
  settingsCachePath = filePath;
  return settingsCache;
}

export function setVisualSettings(input: unknown = {}) {
  const next = normalizeSettings({ ...getVisualSettings(), ...record(input) });
  settingsCache = next;
  settingsCachePath = settingsPath();
  writeJsonAtomic(settingsCachePath, next);
  return visualStatus();
}

function cachePathForModelId(modelId: string) {
  return path.join(modelCacheDir(), ...modelId.split("/"));
}

function visualModelsStatus() {
  return mergeModelCatalog(VISUAL_MODELS, localModelCatalog().visual).map((model) => ({
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
    catalogStatus: localModelCatalog().status,
    cacheDir: modelCacheDir(),
    load: { ...loadState },
  };
}

async function loadDetector(model: (typeof VISUAL_MODELS)[number]) {
  const existing = detectors.get(model.id);
  if (existing) return existing;
  const { pipeline } = await configureTransformersCache();
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

function dataUrlFromImage(input: VisualInput = {}) {
  const mimeType = typeof input.mimeType === "string" ? input.mimeType : "image/png";
  const base64 = typeof input.imageBase64 === "string" ? input.imageBase64 : "";
  if (!base64) throw new Error("visual.mapScreenshot requires imageBase64");
  return `data:${mimeType};base64,${base64}`;
}

function compactString(value: unknown, max: number = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeBox(input: unknown) {
  const box = record(input);
  if (Array.isArray(input) && input.length >= 4) {
    const [xmin = 0, ymin = 0, xmax = 1, ymax = 1] = input.map(Number);
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

function normalizeDetection(input: unknown, index: number) {
  const detection = record(input);
  const label = compactString(detection.label ?? detection.class ?? detection.name ?? `visual-${index + 1}`);
  return {
    node_id: null,
    kind: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "visual",
    label,
    box: normalizeBox(detection.box ?? detection),
    source: "visual",
    score: typeof detection.score === "number" && Number.isFinite(detection.score) ? Number(detection.score.toFixed(4)) : null,
  };
}

async function mapScreenshotLocal(input: VisualInput = {}) {
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
  const threshold = typeof input.threshold === "number" && Number.isFinite(input.threshold) ? input.threshold : settings.threshold;
  const maxResults = input.maxResults !== undefined && Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 80) : 20;

  if (!detector) throw new Error("Visual detector could not be loaded");
  const detections: unknown = await detector(dataUrlFromImage(input), labels, { threshold });

  const results = record(detections).results;
  const raw = Array.isArray(detections) ? detections : Array.isArray(results) ? results : [];
  return {
    enabled: settings.enabled,
    used: true,
    model: { id: model.id, label: model.label },
    elements: raw.slice(0, maxResults).map(normalizeDetection),
  };
}

export async function handleVisualHostMethod(method: string, params: unknown = {}) {
  if (method === "visual.status") return visualStatus();
  if (method === "visual.listModels") return { models: visualModelsStatus(), settings: getVisualSettings(), cacheDir: modelCacheDir() };
  if (method === "visual.setSettings") return setVisualSettings(params);
  if (method === "visual.mapScreenshot") return mapScreenshotLocal(visualInputSchema.parse(params));
  return undefined;
}
