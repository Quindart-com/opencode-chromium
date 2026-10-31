import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonIfPresent } from "../../src/shared/node-files.ts";
import { record } from "../../src/shared/values.ts";
import { DEEP_MODEL_ID,DEFAULT_MODEL_ID,semanticModels } from "./semantic-models.ts";
import { type SemanticModel,type SemanticSettings,type SettingsInput } from "./semantic-types.ts";
export { SEMANTIC_MODELS } from "./semantic-models.ts";

export const SETTINGS_VERSION = 5;
export const AGENT_RESULT_COUNTS = [3, 5, 8, 12, 20];
export const AGENT_RESULT_DETAILS = ["lean", "compact", "debug"];
export const STRATEGY_PREFERENCES = ["auto", "semantic", "lexical", "deep"];


export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_UNITS = 700;
export const DEFAULT_EMBEDDING_CANDIDATES = 48;
export const DEFAULT_RERANK_CANDIDATES = 8;
export const MODEL_CACHE_ENV = "OPENCODE_BROWSER_SEMANTIC_DIR";
export const DISABLE_MODEL_ENV = "AGENT_BROWSER_DISABLE_SEMANTIC_MODEL";
const LEGACY_MODEL_IDS = new Set([
  "Xenova/bge-small-en-v1.5",
  "Xenova/all-MiniLM-L6-v2",
]);
let settingsCache: SemanticSettings | null = null;
let settingsCachePath: string | null = null;

interface SemanticSettingsHooks {
  preload(modelId: string): Promise<unknown>;
  status(): unknown;
}
let settingsHooks: SemanticSettingsHooks | null = null;
export function configureSemanticSettingsHooks(hooks: SemanticSettingsHooks) { settingsHooks = hooks; }

export function appDataDir() {
  const configured = process.env.AGENT_BROWSER_SEMANTIC_DIR ?? process.env[MODEL_CACHE_ENV];
  if (configured) return path.resolve(configured);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenCodeBrowser", "semantic");
  }
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "opencode-browser", "semantic");
  return path.join(os.homedir(), ".cache", "opencode-browser", "semantic");
}

export function semanticDataDir() {
  return appDataDir();
}

export function modelCacheDir() {
  return path.join(semanticDataDir(), "models");
}

export function settingsPath() {
  return path.join(semanticDataDir(), "settings.json");
}

export function ensureSemanticDirs() {
  fs.mkdirSync(modelCacheDir(), { recursive: true });
}

export function modelById(modelId: string) {
  const fallback = semanticModels()[0];
  if (!fallback) throw new Error("No semantic models are configured");
  if (LEGACY_MODEL_IDS.has(modelId)) return fallback;
  return semanticModels().find(model => model.id === modelId) ?? fallback;
}

export function truncateAndRenormalize(vector: ArrayLike<number> | null | undefined, dimensions: number | undefined) {
  const source = Array.isArray(vector) ? vector : Array.from(vector ?? []);
  if (!Number.isInteger(dimensions) || dimensions === undefined || dimensions <= 0 || dimensions >= source.length) return source;
  const truncated = source.slice(0, dimensions);
  const norm = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return truncated;
  return truncated.map((value) => value / norm);
}

export function embeddingProfileFor(model: SemanticModel) {
  const dims = model.embedding.dimensions ?? model.dimensions;
  const dtype = model.embedding.dtype ?? "q8";
  const prompt = model.embedding.promptVersion ?? "prompt-v1";
  return `${model.id}:${dtype}:d${dims}:${prompt}`;
}

export function configuredDimensions(model: SemanticModel, settings = getSemanticSettings()) {
  if (!Array.isArray(model.embedding.supportedDimensions)) return model.embedding.dimensions;
  const requested = typeof settings.embeddingDims === "number" && Number.isInteger(settings.embeddingDims) && model.embedding.supportedDimensions.includes(settings.embeddingDims)
    ? settings.embeddingDims
    : model.embedding.defaultDimensions ?? model.embedding.dimensions;
  return requested;
}

export function effectiveModel(model: SemanticModel, settings = getSemanticSettings()) {
  if (!Array.isArray(model.embedding.supportedDimensions)) return model;
  const dimensions = configuredDimensions(model, settings);
  return {
    ...model,
    dimensions,
    embedding: { ...model.embedding, dimensions },
  };
}

export function semanticModelFor(modelId: string, settings = getSemanticSettings()) {
  return effectiveModel(modelById(modelId), settings);
}

export function normalizeSettings(input: unknown = {}): SemanticSettings {
  const value = record(input);
  const enabled = value.enabled === undefined ? true : value.enabled === true;
  const requestedModelId = typeof value.modelId === "string" ? value.modelId : null;
  const modelId = requestedModelId && semanticModels().some((model) => model.id === requestedModelId && model.role === "adaptive")
    ? requestedModelId
    : DEFAULT_MODEL_ID;
  // Strategy is always derived, never persisted: enabled semantic search is
  // "semantic" (previously reported as the deprecated "snowflake" alias).
  const activeModel = modelById(modelId);
  const supported = Array.isArray(activeModel.embedding.supportedDimensions) ? activeModel.embedding.supportedDimensions : null;
  const embeddingDims = supported && typeof value.embeddingDims === "number" && supported.includes(value.embeddingDims) ? value.embeddingDims : undefined;
  return {
    version: SETTINGS_VERSION,
    enabled,
    strategy: enabled ? "semantic" : "lexical",
    modelId,
    embeddingDims,
    strategyPreference: typeof value.strategyPreference === "string" && STRATEGY_PREFERENCES.includes(value.strategyPreference) ? value.strategyPreference : "auto",
    agentResultCount: typeof value.agentResultCount === "number" && AGENT_RESULT_COUNTS.includes(value.agentResultCount) ? value.agentResultCount : 5,
    agentResultDetail: typeof value.agentResultDetail === "string" && AGENT_RESULT_DETAILS.includes(value.agentResultDetail) ? value.agentResultDetail : "lean",
    deepModelId: typeof value.deepModelId === "string" && semanticModels().some(model => model.id === value.deepModelId && model.role === "deep") ? value.deepModelId : DEEP_MODEL_ID,
  };
}

export function writeJsonAtomic(filePath: fs.PathLike, value: SemanticSettings) {
  ensureSemanticDirs();
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

export function getSemanticSettings(): SemanticSettings {
  const filePath = settingsPath();
  { // Settings are shared across native-host processes. Read the atomic file on each request.
    settingsCache = normalizeSettings(readJsonIfPresent(filePath) ?? {});
    settingsCachePath = filePath;
  }
  if (!settingsCache) throw new Error("Semantic settings could not be loaded");
  return settingsCache;
}

export function setSemanticSettings(input: SettingsInput = {}) {
  const current = getSemanticSettings();
  const merge = { ...current, ...input };
  if (typeof input?.modelId === "string" && !semanticModels().some((model) => model.id === input.modelId && model.role === "adaptive")) {
    merge.modelId = current.modelId;
  }
  if ("embeddingDims" in merge) {
    const target = modelById(merge.modelId);
    const supported = Array.isArray(target.embedding.supportedDimensions) ? target.embedding.supportedDimensions : null;
    if (supported && !supported.includes(merge.embeddingDims ?? -1)) {
      merge.embeddingDims = supported.includes(current.embeddingDims ?? -1) ? current.embeddingDims : undefined;
    }
  }
  const next = normalizeSettings(merge);
  settingsCache = next;
  settingsCachePath = settingsPath();
  writeJsonAtomic(settingsCachePath, next);
  if (next.enabled && input.preload === true) {
    const modelId = typeof input.deepModelId === "string" ? next.deepModelId : next.modelId;
    void settingsHooks?.preload(modelId);
  }
  return settingsHooks?.status() ?? { settings: next };
}
