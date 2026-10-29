import type { PreTrainedTokenizer, Tensor } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { isMainThread,parentPort,Worker,workerData } from "node:worker_threads";
import { record } from "../../src/shared/values.ts";
import { embeddingResultSchema,type EmbeddingResult } from "./memory/embedding-service.ts";
import { DEEP_MODEL_ID,DEFAULT_MODEL_ID,SEMANTIC_MODELS } from "./semantic-models.ts";
import { embeddingInputSchema,pageUnitSchema,rankInputSchema,settingsInputSchema,type BaseRanking,type EmbeddingInput,type Extractor,type LoadState,type NormalizedUnit,type PageUnit,type RankedItem,type RankingOptions,type RankInput,type Reranker,type SemanticModel,type SemanticSettings,type SettingsInput } from "./semantic-types.ts";
export { SEMANTIC_MODELS } from "./semantic-models.ts";

const SETTINGS_VERSION = 5;
const AGENT_RESULT_COUNTS = [3, 5, 8, 12, 20];
const AGENT_RESULT_DETAILS = ["lean", "compact", "debug"];
const STRATEGY_PREFERENCES = ["auto", "semantic", "lexical", "deep"];


const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_UNITS = 700;
const DEFAULT_EMBEDDING_CANDIDATES = 48;
const DEFAULT_RERANK_CANDIDATES = 8;
const MODEL_CACHE_ENV = "OPENCODE_BROWSER_SEMANTIC_DIR";
const DISABLE_MODEL_ENV = "AGENT_BROWSER_DISABLE_SEMANTIC_MODEL";
const IS_SEMANTIC_WORKER = !isMainThread && workerData?.role === "semantic-search";

// Retrieval strategies are decoupled from model identity: "semantic" always
// means the active adaptive embedding model. "snowflake" is a deprecated
// alias kept for one or two releases.
export const SEARCH_STRATEGIES = ["lexical", "auto", "semantic", "deep"];
const LONG_TIMEOUT_STRATEGIES = new Set(["deep", "semantic", "snowflake"]);
function normalizeSearchStrategy(input: string | undefined) {
  if (input === "snowflake") return { strategy: "semantic", deprecatedAlias: true };
  if (input === "semantic") return { strategy: "semantic", deprecatedAlias: false };
  if (input === "auto") return { strategy: "auto", deprecatedAlias: false };
  if (input === "deep") return { strategy: "deep", deprecatedAlias: false };
  if (input === "hybrid") return { strategy: "deep", deprecatedAlias: true };
  if (input === "lexical") return { strategy: "lexical", deprecatedAlias: false };
  return { strategy: "semantic", deprecatedAlias: false };
}
function usesLongTimeout(strategy: string) {
  return LONG_TIMEOUT_STRATEGIES.has(strategy);
}

const LEGACY_MODEL_IDS = new Set([
  "Xenova/bge-small-en-v1.5",
  "Xenova/all-MiniLM-L6-v2",
]);



const embeddingPipelines = new Map<string, Extractor>();
const rerankers = new Map<string, Reranker>();
const loadingByModel = new Map<string, Promise<{ embedding: Extractor | undefined; reranker: Reranker | null }>>();
const queryEmbeddingCache = new Map<string, number[]>();
const documentEmbeddingCache = new Map<string, number[]>();
let deepIdleTimer: ReturnType<typeof setTimeout> | null = null;

const loadState: LoadState = {
  state: "idle",
  modelId: null,
  component: null,
  startedAt: null,
  completedAt: null,
  error: null,
  file: null,
  progress: null,
};

let settingsCache: SemanticSettings | null = null;
let settingsCachePath: string | null = null;
let semanticWorker: Worker|null = null;
let semanticWorkerDir: string|null = null;
let semanticWorkerRequestId = 1;
const semanticWorkerPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();

function nowIso() {
  return new Date().toISOString();
}

function semanticWorkerInstance() {
  if (IS_SEMANTIC_WORKER) return null;
  const currentDir = semanticDataDir();
  if (semanticWorker && semanticWorkerDir !== currentDir) {
    semanticWorker.removeAllListeners();
    semanticWorker.terminate().catch(() => {});
    semanticWorker = null;
    semanticWorkerDir = null;
  }
  if (semanticWorker) return semanticWorker;
  semanticWorkerDir = currentDir;
  semanticWorker = new Worker(new URL("./semantic-search.ts", import.meta.url), {
    workerData: { role: "semantic-search" },
    env: { ...process.env, [MODEL_CACHE_ENV]: currentDir },
  });
  const worker = semanticWorker;
  semanticWorker.unref();
  worker.on("message", (message) => {
    const pending = semanticWorkerPending.get(message?.id);
    if (!pending) return;
    semanticWorkerPending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  const reset = (error: Error) => {
    const pending = [...semanticWorkerPending.values()];
    semanticWorkerPending.clear();
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(error instanceof Error ? error : new Error(String(error ?? "Semantic worker stopped")));
    }
    semanticWorker = null;
    semanticWorkerDir = null;
  };
  worker.on("error", reset);
  worker.on("exit", (code) => {
    if (semanticWorker !== worker) return;
    if (code !== 0) reset(new Error(`Semantic worker exited with code ${code}`));
    else {
      semanticWorker = null;
      semanticWorkerDir = null;
    }
  });
  return semanticWorker;
}

function semanticWorkerRequest(method: string, params: Record<string, unknown> = {}, timeoutMs: number = 900000) {
  return new Promise<unknown>((resolve, reject) => {
    const worker = semanticWorkerInstance();
    if (!worker) { reject(new Error("Semantic worker is unavailable")); return; }
    const id = semanticWorkerRequestId++;
    const timeout = setTimeout(() => {
      semanticWorkerPending.delete(id);
      reject(new Error(`Timed out waiting for semantic worker response to ${method}`));
    }, timeoutMs);
    semanticWorkerPending.set(id, { resolve, reject, timeout });
    worker.postMessage({ id, method, params });
  });
}

function appDataDir() {
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

function modelCacheDir() {
  return path.join(semanticDataDir(), "models");
}

function settingsPath() {
  return path.join(semanticDataDir(), "settings.json");
}

function ensureSemanticDirs() {
  fs.mkdirSync(modelCacheDir(), { recursive: true });
}

function modelById(modelId: string) {
  const fallback = SEMANTIC_MODELS[0];
  if (!fallback) throw new Error("No semantic models are configured");
  if (LEGACY_MODEL_IDS.has(modelId)) return fallback;
  return SEMANTIC_MODELS.find(model => model.id === modelId) ?? fallback;
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

function configuredDimensions(model: SemanticModel, settings = getSemanticSettings()) {
  if (!Array.isArray(model.embedding.supportedDimensions)) return model.embedding.dimensions;
  const requested = typeof settings.embeddingDims === "number" && Number.isInteger(settings.embeddingDims) && model.embedding.supportedDimensions.includes(settings.embeddingDims)
    ? settings.embeddingDims
    : model.embedding.defaultDimensions ?? model.embedding.dimensions;
  return requested;
}

function effectiveModel(model: SemanticModel, settings = getSemanticSettings()) {
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

function normalizeSettings(input: unknown = {}): SemanticSettings {
  const value = record(input);
  const enabled = value.enabled === undefined ? true : value.enabled === true;
  const requestedModelId = typeof value.modelId === "string" ? value.modelId : null;
  const modelId = requestedModelId && SEMANTIC_MODELS.some((model) => model.id === requestedModelId && model.role === "adaptive")
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
    deepModelId: DEEP_MODEL_ID,
  };
}

function readJsonIfPresent(filePath: fs.PathLike) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return (JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: fs.PathLike, value: SemanticSettings) {
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
  if (typeof input?.modelId === "string" && !SEMANTIC_MODELS.some((model) => model.id === input.modelId && model.role === "adaptive")) {
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
    if (!IS_SEMANTIC_WORKER) updateLoadState({ state: "loading", modelId: next.modelId, component: "embedding", startedAt: nowIso(), completedAt: null, error: null });
    const preload = IS_SEMANTIC_WORKER ? prepareSemanticModelLocal(next.modelId) : semanticWorkerRequest("semantic.prepareModel", { modelId: next.modelId });
    void preload.catch((error) => updateLoadState({ state: "error", modelId: next.modelId, completedAt: nowIso(), error: error instanceof Error ? error.message : String(error) }));
  }
  return semanticStatus();
}

async function configureTransformersCache() {
  const runtime = await import("@huggingface/transformers");
  const { env } = runtime;
  ensureSemanticDirs();
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  // Remote model files are only used for first-time downloads. Inference runs locally.
  env.allowRemoteModels = true;
  return runtime;
}

function updateLoadState(patch: Partial<LoadState>) {
  Object.assign(loadState, patch);
}

function progressFor(model: SemanticModel, component: string) {
  return (input: unknown) => {
    const progress = record(input);
    updateLoadState({
      state: "loading",
      modelId: model.id,
      component,
      file: typeof progress?.file === "string" ? progress.file : loadState.file,
      progress: Number.isFinite(progress?.progress) ? Math.round(Number(progress.progress)) : loadState.progress,
    });
  };
}

async function disposeMaybe(value: { dispose?(): Promise<unknown> } | null | undefined) {
  if (value && typeof value.dispose === "function") await value.dispose();
}

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  if (value !== undefined) cache.set(key, value);
  return value;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) { const first = cache.keys().next(); if (first.done) break; cache.delete(first.value); }
}

async function unloadModelsExcept(modelId: string) {
  for (const [id, extractor] of embeddingPipelines) {
    if (id === modelId) continue;
    embeddingPipelines.delete(id);
    await disposeMaybe(extractor);
  }
  for (const [id, reranker] of rerankers) {
    if (id === modelId) continue;
    rerankers.delete(id);
    await disposeMaybe(reranker?.model);
  }
}

function scheduleDeepUnload() {
  if (deepIdleTimer) clearTimeout(deepIdleTimer);
  deepIdleTimer = setTimeout(() => {
    const extractor = embeddingPipelines.get(DEEP_MODEL_ID);
    const reranker = rerankers.get(DEEP_MODEL_ID);
    embeddingPipelines.delete(DEEP_MODEL_ID);
    rerankers.delete(DEEP_MODEL_ID);
    void Promise.all([disposeMaybe(extractor), disposeMaybe(reranker?.model)]).finally(() => {
      queryEmbeddingCache.clear();
      documentEmbeddingCache.clear();
    });
  }, 2 * 60 * 1000);
  deepIdleTimer.unref?.();
}

const ONNX_SESSION_OPTIONS = {
  intraOpNumThreads: 4,
  interOpNumThreads: 1,
  executionMode: "sequential" as const,
};

async function loadEmbedding(model: SemanticModel) {
  const existing = embeddingPipelines.get(model.id);
  if (existing) return existing;
  await unloadModelsExcept(model.id);
  await configureTransformersCache();
  const { AutoTokenizer, AutoModel, pipeline, Tensor } = await configureTransformersCache();
  let extractor: Extractor;
  if (model.embedding.adapter === "embeddinggemma") {
    const tokenizer = await AutoTokenizer.from_pretrained(model.embedding.id, {
      progress_callback: progressFor(model, "embedding-tokenizer"),
    });
    const embeddingModel = await AutoModel.from_pretrained(model.embedding.id, {
      dtype: model.embedding.dtype,
      session_options: ONNX_SESSION_OPTIONS,
      progress_callback: progressFor(model, "embedding"),
    });
    extractor = async (texts: string[]) => {
      const inputs = tokenizer(texts, { padding: true, truncation: true });
      const outputs = await embeddingModel(inputs);
      if (!outputs?.sentence_embedding) throw new Error("EmbeddingGemma export did not return sentence_embedding");
      const tensor: unknown = outputs.sentence_embedding;
      if (!(tensor instanceof Tensor)) throw new Error("Invalid sentence embedding tensor");
      return tensor;
    };
    extractor.dispose = async () => disposeMaybe(embeddingModel);
  } else {
    const featureExtractor = await pipeline("feature-extraction", model.embedding.id, {
      dtype: model.embedding.dtype,
      session_options: ONNX_SESSION_OPTIONS,
      progress_callback: progressFor(model, "embedding"),
    });
    extractor = async (texts, options) => { const tensor = await featureExtractor(texts, options); if (!(tensor instanceof Tensor)) throw new Error("Invalid feature tensor"); return tensor; };
    extractor.dispose = () => featureExtractor.dispose();
  }
  await unloadModelsExcept(model.id);
  embeddingPipelines.set(model.id, extractor);
  return extractor;
}

async function loadReranker(model: SemanticModel) {
  if (!model.reranker) return null;
  const existing = rerankers.get(model.id);
  if (existing) return existing;
  configureTransformersCache();
  const { AutoTokenizer, AutoModelForCausalLM } = await configureTransformersCache();
  const tokenizer = await AutoTokenizer.from_pretrained(model.reranker.id, {
    progress_callback: progressFor(model, "reranker-tokenizer"),
  });

  let causalModel;
  let dtype = model.reranker.dtype;
  try {
    causalModel = await AutoModelForCausalLM.from_pretrained(model.reranker.id, {
      dtype,
      session_options: ONNX_SESSION_OPTIONS,
      progress_callback: progressFor(model, "reranker"),
    });
  } catch (error) {
    if (!model.reranker.fallbackDtype || model.reranker.fallbackDtype === dtype) throw error;
    dtype = model.reranker.fallbackDtype;
    causalModel = await AutoModelForCausalLM.from_pretrained(model.reranker.id, {
      dtype,
      session_options: ONNX_SESSION_OPTIONS,
      progress_callback: progressFor(model, "reranker"),
    });
  }

  const yesTokenId = tokenId(tokenizer, "yes");
  const noTokenId = tokenId(tokenizer, "no");
  const reranker = { tokenizer, model: causalModel, dtype, yesTokenId, noTokenId };
  await unloadModelsExcept(model.id);
  rerankers.set(model.id, reranker);
  return reranker;
}

async function prepareSemanticModelLocal(modelId = getSemanticSettings().modelId) {
  const model = modelById(modelId);
  if (embeddingPipelines.has(model.id) && (!model.reranker || rerankers.has(model.id))) {
    updateLoadState({ state: "ready", modelId: model.id, component: "all", completedAt: nowIso(), error: null, file: null, progress: 100 });
    return { embedding: embeddingPipelines.get(model.id), reranker: rerankers.get(model.id) ?? null };
  }
  if (loadingByModel.has(model.id)) return loadingByModel.get(model.id);

  configureTransformersCache();
  updateLoadState({ state: "loading", modelId: model.id, component: "embedding", startedAt: nowIso(), completedAt: null, error: null, file: null, progress: null });

  const loading = (async () => {
    const embedding = await loadEmbedding(model);
    let reranker = null;
    if (model.reranker) {
      updateLoadState({ state: "loading", modelId: model.id, component: "reranker", file: null, progress: null });
      reranker = await loadReranker(model);
    }
    updateLoadState({ state: "ready", modelId: model.id, component: "all", completedAt: nowIso(), error: null, file: null, progress: 100 });
    return { embedding, reranker };
  })()
    .catch((error) => {
      updateLoadState({ state: "error", modelId: model.id, completedAt: nowIso(), error: error instanceof Error ? error.message : String(error) });
      throw error;
    })
    .finally(() => {
      loadingByModel.delete(model.id);
    });

  loadingByModel.set(model.id, loading);
  return loading;
}

export async function prepareSemanticModel(modelId = getSemanticSettings().modelId) {
  return prepareSemanticModelLocal(modelId);
}

function cachePathForModelId(modelId: string) {
  return path.join(modelCacheDir(), ...modelId.split("/"));
}

function removeEmptyParentDirs(filePath: string) {
  let current = path.dirname(filePath);
  const root = modelCacheDir();
  while (current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function cacheInfoForModel(model: SemanticModel) {
  const components = [model.embedding, model.reranker].filter((value): value is NonNullable<typeof value> => value !== undefined && value !== null);
  const paths = components.map((component) => cachePathForModelId(component.id));
  const files = components.map((component) => {
    const suffix = component.dtype === "q8" ? "_quantized" : component.dtype === "q4" ? "_q4" : component.dtype === "fp16" ? "_fp16" : "";
    return path.join(cachePathForModelId(component.id), "onnx", `model${suffix}.onnx`);
  });
  return {
    cached: files.every((filePath) => fs.existsSync(filePath)),
    paths,
    files,
  };
}

function semanticModelsStatus() {
  return SEMANTIC_MODELS.map((model) => {
    const effective = effectiveModel(model);
    return {
      ...effective,
      cache: cacheInfoForModel(model),
      ...(Array.isArray(model.embedding.supportedDimensions)
        ? {
            supportedDimensions: model.embedding.supportedDimensions,
            defaultDimensions: model.embedding.defaultDimensions,
            nativeDimensions: model.embedding.nativeDimensions,
            supportedDtypes: model.embedding.supportedDtypes,
          }
        : {}),
    };
  });
}

export function semanticStatus() {
  const settings = getSemanticSettings();
  return {
    settings,
    models: semanticModelsStatus(),
    cache: { kind: "local" },
    load: { ...loadState },
    runtime: { backend: "onnxruntime-node", intraOpThreads: 4, interOpThreads: 1, maxLoadedModels: 1, deepIdleMs: 120000 },
  };
}

async function deleteSemanticModelLocal(modelId = getSemanticSettings().modelId) {
  const model = modelById(modelId);
  if (loadingByModel.has(model.id)) throw new Error(`Cannot delete ${model.label} while it is loading`);

  const extractor = embeddingPipelines.get(model.id);
  embeddingPipelines.delete(model.id);
  await disposeMaybe(extractor);

  const reranker = rerankers.get(model.id);
  rerankers.delete(model.id);
  await disposeMaybe(reranker?.model);

  const deleted = [];
  for (const modelFileId of [model.embedding.id, model.reranker?.id].filter((value): value is NonNullable<typeof value> => value !== undefined && value !== null)) {
    const filePath = cachePathForModelId(modelFileId);
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { recursive: true, force: true });
    removeEmptyParentDirs(filePath);
    deleted.push(filePath);
  }

  updateLoadState({ state: "idle", modelId: null, component: null, completedAt: nowIso(), error: null, file: null, progress: null });
  return { ...semanticStatus(), deleted };
}

export async function deleteSemanticModel(modelId = getSemanticSettings().modelId) {
  return deleteSemanticModelLocal(modelId);
}

function compactString(value: unknown, max: number = 500) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function unitText(unit: PageUnit) {
  const parts = [
    unit.kind,
    unit.role,
    unit.name,
    unit.ariaName,
    unit.label,
    unit.placeholder,
    unit.text,
    Array.isArray(unit.headingPath) ? unit.headingPath.join(" > ") : unit.headingPath,
    unit.landmark,
    unit.selector,
  ];
  return compactString(parts.filter((value): value is NonNullable<typeof value> => value !== undefined && value !== null).join(" | "), 1200);
}

function tokenize(value: string) {
  return compactString(value, 2000).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

function lexicalScore(normalizedQuery: string, queryTokens: string[], text: string) {
  const normalizedText = compactString(text, 2000).toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;

  if (!queryTokens.length) return normalizedText.includes(normalizedQuery) ? 0.7 : 0;

  const textTokens = new Set(tokenize(normalizedText));
  const matches = queryTokens.filter((token) => textTokens.has(token)).length;
  const overlap = matches / queryTokens.length;
  const phrase = normalizedText.includes(normalizedQuery) ? 0.35 : 0;
  const partial = queryTokens.some((token) => normalizedText.includes(token)) ? 0.1 : 0;
  return Math.min(1, phrase + partial + overlap * 0.55);
}

function unitBoost(unit: PageUnit | undefined) {
  let boost = 0;
  if (unit?.interactive) boost += 0.05;
  if (unit?.inViewport) boost += 0.03;
  if (unit?.disabled) boost -= 0.15;
  if (unit?.kind === "heading") boost -= 0.02;
  return boost;
}

function dot(first: ArrayLike<number>, second: ArrayLike<number>) {
  let total = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) total += (first[index] ?? 0) * (second[index] ?? 0);
  return total;
}

function rowsFromTensor(tensor: Tensor, expectedRows: number) {
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  const data = tensor?.data;
  if (!data || !dims.length) return [];
  const width = dims.at(-1) ?? 0;
  const rows = dims.length === 1 ? 1 : (dims[0] ?? 0);
  const count = expectedRows ?? rows;
  const output = [];
  for (let row = 0; row < Math.min(rows, count); row += 1) {
    output.push(Array.from(data.slice(row * width, row * width + width), Number));
  }
  return output;
}

function modelQuery(model: SemanticModel, query: string) {
  if (model.embedding.queryPrefix) return `${model.embedding.queryPrefix}${query}`;
  return `Instruct: ${model.embedding.task}\nQuery:${query}`;
}

function modelDocument(model: SemanticModel, text: string) {
  if (model.embedding.documentPrefix) return `${model.embedding.documentPrefix}${text}`;
  return text;
}

async function embedTexts(extractor: Extractor, texts: string | string[], model: SemanticModel) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (model.embedding.adapter === "embeddinggemma") {
    // The dedicated loader returns sentence_embedding directly; Matryoshka
    // truncation must then be followed by re-normalization.
    const tensor = await extractor(list);
    const rows = rowsFromTensor(tensor, list.length);
    return rows.map((row) => truncateAndRenormalize(row, model.embedding.dimensions));
  }
  const tensor = await extractor(list, { pooling: model.embedding.pooling, normalize: true });
  return rowsFromTensor(tensor, list.length);
}

function embeddingCandidateIndexes(units: NormalizedUnit[], lexical: number[], input: RankInput = {}) {
  const limit = Number.isInteger(input.embeddingCandidates) && input.embeddingCandidates !== undefined && input.embeddingCandidates > 0
    ? Math.min(input.embeddingCandidates, 500)
    : DEFAULT_EMBEDDING_CANDIDATES;
  if (units.length <= limit) return units.map((_, index) => index);

  const byLexical = units
    .map((unit, index) => ({ index, score: lexical[index] ?? 0, unit }))
    .sort((first, second) => second.score - first.score)
    .slice(0, Math.ceil(limit * 0.7));
  const byStructure = units
    .map((unit, index) => ({ index, unit }))
    .filter((item) => item.unit.interactive || item.unit.inViewport || item.unit.kind === "heading" || item.unit.kind === "region")
    .slice(0, Math.floor(limit * 0.3));
  return [...new Set([...byLexical, ...byStructure].map((item) => item.index))].slice(0, limit);
}

function shortHash(value: string) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

async function semanticScores(model: SemanticModel, query: string, documents: string[], indexes: number[], pageFingerprint: string = "") {
  const extractor = await loadEmbedding(model);
  const profile = embeddingProfileFor(model);
  const queryKey = `${profile}:${shortHash(query)}`;
  let queryEmbedding = lruGet(queryEmbeddingCache, queryKey);
  let queryCacheHit = true;
  if (!queryEmbedding) {
    [queryEmbedding] = await embedTexts(extractor, modelQuery(model, query), model);
    if (!queryEmbedding) throw new Error("Missing query embedding");
    lruSet(queryEmbeddingCache, queryKey, queryEmbedding, 128);
    queryCacheHit = false;
  }
  const scores: (number | null)[] = Array(documents.length).fill(null);
  const embeddings = new Map<number, number[]>();
  const missing = [];
  let documentCacheHits = 0;
  for (const index of indexes) {
    const key = `${profile}:${shortHash(pageFingerprint)}:${shortHash(documents[index] ?? "")}`;
    const cached = lruGet(documentEmbeddingCache, key);
    if (cached) {
      embeddings.set(index, cached);
      documentCacheHits += 1;
    } else {
      missing.push({ index, key });
    }
  }
  const batchSize = 16;
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const vectors = await embedTexts(extractor, batch.map((item) => modelDocument(model, documents[item.index] ?? "")), model);
    vectors.forEach((embedding, offset) => {
      const item = batch[offset];
      if (!item) throw new Error("Unexpected embedding batch response");
      embeddings.set(item.index, embedding);
      lruSet(documentEmbeddingCache, item.key, embedding, 1024);
    });
  }
  for (const [index, embedding] of embeddings) {
    const raw = dot(queryEmbedding, embedding);
    scores[index] = Math.max(0, Math.min(1, (raw + 1) / 2));
  }
  return { scores, queryCacheHit, documentCacheHits };
}

function tokenId(tokenizer: PreTrainedTokenizer, token: string): number {
  if (typeof tokenizer.convert_tokens_to_ids === "function") {
    const id: unknown = tokenizer.convert_tokens_to_ids(token);
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) return id;
  }
  const encoded = tokenizer(token, { add_special_tokens: false });
  const data = encoded?.input_ids?.data ?? encoded?.input_ids;
  const value = Array.from(data ?? [])[0];
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  throw new Error(`Could not resolve reranker token id for ${token}`);
}

function rerankerPrompt(model: SemanticModel, query: string, document: string) {
  if (!model.reranker) throw new Error("No reranker is configured");
  const system = "Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".";
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<Instruct>: ${model.reranker.instruction}\n\n<Query>: ${query}\n\n<Document>: ${document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

function lastTokenLogits(logits: Tensor) {
  const dims = Array.isArray(logits?.dims) ? logits.dims : [];
  const data = logits?.data;
  if (!data || dims.length < 2) throw new Error("Reranker returned logits without tensor data");
  const vocabSize = dims.at(-1) ?? 0;
  const seqLen = (dims.length === 3 ? dims[1] : dims[0]) ?? 0;
  return Array.from(data.slice((seqLen - 1) * vocabSize, seqLen * vocabSize), Number);
}

async function rerankerScore(model: SemanticModel, reranker: Reranker, query: string, document: string) {
  if (!model.reranker) throw new Error("No reranker is configured");
  const prompt = rerankerPrompt(model, query, compactString(document, 1800));
  const inputs = reranker.tokenizer(prompt, { truncation: true, max_length: model.reranker.maxLength });
  const output = await reranker.model(inputs);
  const logits = lastTokenLogits(output.logits);
  const yes = logits[reranker.yesTokenId];
  const no = logits[reranker.noTokenId];
  if (yes === undefined || no === undefined || !Number.isFinite(yes) || !Number.isFinite(no)) throw new Error("Reranker did not return finite yes/no logits");
  const max = Math.max(yes, no);
  const yesExp = Math.exp(yes - max);
  const noExp = Math.exp(no - max);
  return yesExp / (yesExp + noExp);
}

async function rerankerScores(model: SemanticModel, query: string, documents: string[], rankedItems: RankedItem[], input: RankInput = {}) {
  const reranker = await loadReranker(model);
  if (!reranker) throw new Error("No reranker is configured");
  const limit = Number.isInteger(input.rerankCandidates) && input.rerankCandidates !== undefined && input.rerankCandidates > 0
    ? Math.min(input.rerankCandidates, 80)
    : DEFAULT_RERANK_CANDIDATES;
  const candidates = rankedItems.slice(0, limit);
  const scores = new Map<number, number>();
  for (const item of candidates) {
    scores.set(item.unit.index, await rerankerScore(model, reranker, query, documents[item.unit.index] ?? ""));
  }
  return { scores, count: candidates.length, dtype: reranker.dtype };
}

function normalizeUnits(units: unknown[] | undefined) {
  if (!Array.isArray(units)) return [];
  return units
    .slice(0, DEFAULT_MAX_UNITS)
    .flatMap(value => { const parsed = pageUnitSchema.safeParse(value); return parsed.success ? [parsed.data] : []; })
    .map((unit, index) => ({
      index,
      ...unit,
      text: compactString(unit?.text, 700),
      name: compactString(unit?.name ?? unit?.ariaName, 240),
      ariaName: compactString(unit?.ariaName, 240),
      label: compactString(unit?.label, 240),
      placeholder: compactString(unit?.placeholder, 160),
      selector: compactString(unit?.selector, 300),
    }))
    .filter((unit) => compactString(unitText(unit)).length > 0);
}

function publicResult(unit: PageUnit, score: number, components: { lexical: number; embedding: number | null; reranker: number | null }) {
  return {
    node_id: unit.node_id ?? unit.nodeId ?? null,
    ...(unit.frameId ? { frameId: unit.frameId } : {}),
    kind: unit.kind ?? null,
    tagName: unit.tagName ?? null,
    role: unit.role ?? null,
    name: unit.name || unit.ariaName || null,
    text: unit.text || null,
    selector: unit.selector || null,
    boundingBox: unit.boundingBox ?? null,
    disabled: unit.disabled === true,
    interactive: unit.interactive === true,
    headingPath: unit.headingPath ?? null,
    landmark: unit.landmark ?? null,
    score: Number(score.toFixed(4)),
    scores: components,
  };
}

function lexicalIsConfident(query: string, documents: string[], ranked: RankedItem[]) {
  const normalized = compactString(query).toLocaleLowerCase();
  const phraseMatches = documents.filter((text) => compactString(text, 2000).toLocaleLowerCase().includes(normalized)).length;
  if (phraseMatches === 1) return true;
  const tokens = [...new Set(tokenize(query))];
  const fullTokenMatches = documents.filter((text) => {
    const haystack = new Set(tokenize(text));
    return tokens.length > 0 && tokens.every((token) => haystack.has(token));
  }).length;
  if (fullTokenMatches === 1) return true;
  return (ranked[0]?.lexical ?? 0) >= 0.78 && (ranked[0]?.lexical ?? 0) - (ranked[1]?.lexical ?? 0) >= 0.18;
}

function baseRanking(input: RankInput = {}) {
  const query = compactString(input.query, 500);
  if (!query) throw new Error("semantic.rankPageUnits requires query");
  const maxResults = Number.isInteger(input.maxResults) && input.maxResults !== undefined && input.maxResults > 0 ? Math.min(input.maxResults, 100) : DEFAULT_MAX_RESULTS;
  const units = normalizeUnits(input.units);
  const documents = units.map(unitText);
  const normalizedQuery = compactString(query).toLowerCase();
  const queryTokens = [...new Set(tokenize(normalizedQuery))];
  const lexical = documents.map((text, index) => lexicalScore(normalizedQuery, queryTokens, text) + unitBoost(units[index]));
  const ranked: RankedItem[] = units.map((unit, index) => ({
    unit,
    score: Math.max(0, Math.min(1, lexical[index] ?? 0)),
    lexical: Math.max(0, Math.min(1, lexical[index] ?? 0)),
    embedding: null,
    reranker: null,
  })).sort((first, second) => second.score - first.score);
  return { query, maxResults, units, documents, lexical, ranked };
}

function formatRanking(base: BaseRanking, options: RankingOptions = {}) {
  const ranked = (options.ranked ?? base.ranked).slice(0, base.maxResults);
  const model = options.model ?? modelById(DEFAULT_MODEL_ID);
  return {
    enabled: options.enabled ?? getSemanticSettings().enabled,
    mode: options.mode ?? "lexical",
    searchStrategy: options.searchStrategy ?? options.mode ?? "lexical",
    deprecatedAlias: options.deprecatedAlias === true,
    degraded: options.degraded === true,
    degradationReason: options.degradationReason ?? null,
    cache: options.cache ?? { queryHit: false, documentHits: 0 },
    model: {
      id: model.id,
      label: model.label,
      used: options.modelUsed === true,
      error: options.modelError ?? null,
      embedding: { id: model.embedding.id, used: options.modelUsed === true, error: options.modelError ?? null },
      ...(model.reranker ? { reranker: { id: model.reranker.id, used: options.rerankerUsed === true, error: options.rerankerError ?? null, candidates: options.rerankerCount ?? 0, dtype: options.rerankerDtype ?? null } } : {}),
    },
    totalUnits: base.units.length,
    returned: ranked.length,
    results: ranked.map((item) => publicResult(item.unit, item.score, {
      lexical: Number(item.lexical.toFixed(4)),
      embedding: item.embedding === null ? null : Number(item.embedding.toFixed(4)),
      reranker: item.reranker === null ? null : Number(item.reranker.toFixed(4)),
    })),
  };
}

async function rankPageUnitsLocal(input: RankInput = {}) {
  const settings = getSemanticSettings();
  const { strategy: requestedStrategy, deprecatedAlias } = normalizeSearchStrategy(input.mode);
  const base = baseRanking(input);
  if (requestedStrategy === "lexical" || requestedStrategy === "auto" &&
    (!settings.enabled || lexicalIsConfident(base.query, base.documents, base.ranked))) {
    return formatRanking(base, { enabled: settings.enabled, mode: "lexical", searchStrategy: requestedStrategy, deprecatedAlias });
  }

  const model = semanticModelFor(requestedStrategy === "deep" ? settings.deepModelId : settings.modelId, settings);
  if (requestedStrategy === "semantic" && !settings.enabled) {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedStrategy,
      deprecatedAlias,
      degraded: true,
      degradationReason: "model-disabled",
      model,
      modelError: "Semantic retrieval is disabled; pass searchStrategy=\"lexical\" or enable semantic search",
    });
  }
  if ((process.env[DISABLE_MODEL_ENV] ?? process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL) === "1") {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedStrategy,
      deprecatedAlias,
      degraded: true,
      degradationReason: "model-unavailable",
      model,
      modelError: "Semantic model loading is disabled",
    });
  }
  if (requestedStrategy === "auto" && !embeddingPipelines.has(model.id)) {
    void prepareSemanticModelLocal(model.id).catch(() => {});
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: "auto",
      deprecatedAlias,
      degraded: true,
      degradationReason: loadState.state === "error" ? "model-unavailable" : "model-preparing",
      model,
      modelError: loadState.error,
    });
  }

  let embeddingResult;
  try {
    if (["semantic", "deep"].includes(requestedStrategy)) await prepareSemanticModelLocal(model.id);
    const indexes = embeddingCandidateIndexes(base.units, base.lexical, {
      ...input,
      embeddingCandidates: requestedStrategy === "deep" ? Math.min(input.embeddingCandidates ?? 120, 120) : Math.min(input.embeddingCandidates ?? 48, 48),
    });
    embeddingResult = await semanticScores(model, base.query, base.documents, indexes, input.pageFingerprint ?? "");
  } catch (error) {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedStrategy,
      deprecatedAlias,
      degraded: true,
      degradationReason: "model-failure",
      model,
      modelError: error instanceof Error ? error.message : String(error),
    });
  }

  const preliminary: RankedItem[] = base.units.map((unit, index) => {
    const lexical = Math.max(0, Math.min(1, base.lexical[index] ?? 0));
    const embedding = embeddingResult.scores[index] ?? null;
    const score = embedding === null ? lexical : embedding * 0.72 + lexical * 0.28;
    return { unit, score, lexical, embedding, reranker: null };
  }).sort((first, second) => second.score - first.score);

  let ranked: RankedItem[] = preliminary;
  let rerankerUsed = false;
  let rerankerError = null;
  let rerankerCount = 0;
  let rerankerDtype = null;
  if (requestedStrategy === "deep" && model.reranker && preliminary.length > 0) {
    try {
      const reranked = await rerankerScores(model, base.query, base.documents, preliminary, input);
      rerankerUsed = reranked.scores.size > 0;
      rerankerCount = reranked.count;
      rerankerDtype = reranked.dtype;
      ranked = preliminary.map((item) => {
        const reranker = reranked.scores.get(item.unit.index) ?? null;
        const score = reranker === null ? item.score * 0.82 : reranker * 0.76 + (item.embedding ?? 0) * 0.18 + item.lexical * 0.06;
        return { ...item, reranker, score };
      }).sort((first, second) => second.score - first.score);
    } catch (error) {
      rerankerError = error instanceof Error ? error.message : String(error);
    }
  }
  if (requestedStrategy === "deep") scheduleDeepUnload();

  return formatRanking(base, {
    enabled: settings.enabled,
    mode: requestedStrategy === "deep" ? "deep" : "adaptive",
    searchStrategy: requestedStrategy,
    deprecatedAlias,
    ranked,
    model,
    modelUsed: true,
    rerankerUsed,
    rerankerError,
    rerankerCount,
    rerankerDtype,
    cache: { queryHit: embeddingResult.queryCacheHit, documentHits: embeddingResult.documentCacheHits },
  });
}

export async function rankPageUnits(input: RankInput = {}) {
  return rankPageUnitsLocal(input);
}

export async function embedMemoryTexts(texts: string[], { modelId = null, timeoutMs = 900000 }: { modelId?: string | null; timeoutMs?: number } = {}): Promise<EmbeddingResult> {
  return embeddingResultSchema.parse(await handleSemanticHostMethod("semantic.embedMemory", { texts, modelId, timeoutMs }));
}

export async function handleSemanticHostMethod(method: string, input: unknown = {}) {
  const params = record(input);
  if (method === "semantic.workerStatus") return semanticStatus();
  if (method === "semantic.getSettings" || method === "semantic.status") {
    if (!IS_SEMANTIC_WORKER && semanticWorker) return semanticWorkerRequest("semantic.workerStatus", {}, 2000).catch(() => semanticStatus());
    return semanticStatus();
  }
  if (method === "semantic.listModels") return { models: semanticModelsStatus(), settings: getSemanticSettings(), cache: { kind: "local" } };
  if (method === "semantic.cacheDiagnostics") return { cacheDir: modelCacheDir(), cache: { kind: "local" } };
  if (method === "semantic.setSettings") return setSemanticSettings(settingsInputSchema.parse(params));
  if (method === "semantic.prepareModel") {
    const settings = getSemanticSettings();
    const modelId = typeof params.modelId === "string" ? params.modelId : settings.modelId;
    if (IS_SEMANTIC_WORKER) {
      await prepareSemanticModelLocal(modelId);
      return semanticStatus();
    }
    try {
      return await semanticWorkerRequest("semantic.prepareModel", { modelId });
    } catch (error) {
      updateLoadState({ state: "error", modelId, completedAt: nowIso(), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  if (method === "semantic.deleteModel") {
    if (IS_SEMANTIC_WORKER) return deleteSemanticModelLocal(typeof params.modelId === "string" ? params.modelId : undefined);
    return semanticWorkerRequest("semantic.deleteModel", { modelId: params.modelId });
  }
  if (method === "semantic.rankPageUnits") {
    if (IS_SEMANTIC_WORKER) return rankPageUnitsLocal(rankInputSchema.parse(params));
    const { strategy } = normalizeSearchStrategy(typeof params.mode === "string" ? params.mode : undefined);
    try {
      const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.max(250, Math.min(params.timeoutMs, usesLongTimeout(strategy) ? 120000 : 10000))
        : usesLongTimeout(strategy) ? 120000 : 10000;
      return await semanticWorkerRequest("semantic.rankPageUnits", params, timeoutMs);
    } catch (error) {
      return formatRanking(baseRanking(rankInputSchema.parse(params)), {
        enabled: getSemanticSettings().enabled,
        mode: "lexical",
        searchStrategy: strategy,
        degraded: true,
        degradationReason: /timed?\s*out/i.test(String(error)) ? "semantic-timeout" : "semantic-worker-failure",
        model: modelById(strategy === "deep" ? DEEP_MODEL_ID : getSemanticSettings().modelId),
        modelError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (method === "semantic.embedMemory") {
    if (IS_SEMANTIC_WORKER) return embedMemoryLocal(embeddingInputSchema.parse(params));
    const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.min(Math.max(params.timeoutMs, 250), 900000) : 900000;
    return semanticWorkerRequest("semantic.embedMemory", params, timeoutMs);
  }
  return undefined;
}

async function embedMemoryLocal({ texts = [], modelId = null }: EmbeddingInput = { texts: [] }) {
  const list = Array.isArray(texts) ? texts.filter((text) => typeof text === "string" && text.length > 0) : [];
  if (list.length === 0) return { model: null, dims: null, embeddingProfile: null, vectors: [] };
  const selected = modelId ?? getSemanticSettings().modelId;
  await prepareSemanticModelLocal(selected);
  const model = semanticModelFor(selected);
  if (!model) return { model: null, dims: null, embeddingProfile: null, vectors: [] };
  const extractor = await loadEmbedding(model);
  const vectors = [];
  for (const text of list) {
    const [vector] = await embedTexts(extractor, modelQuery(model, text), model);
    vectors.push(Array.isArray(vector) ? vector : Array.from(vector ?? []));
  }
  return { model: model.id, dims: model.embedding.dimensions, embeddingProfile: embeddingProfileFor(model), vectors };
}

if (IS_SEMANTIC_WORKER) {
  parentPort?.on("message", async (message) => {
    try {
      const result = await handleSemanticHostMethod(message.method, message.params ?? {});
      parentPort?.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
