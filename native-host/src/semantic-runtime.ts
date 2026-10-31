import type { PreTrainedTokenizer } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { isMainThread,Worker,workerData } from "node:worker_threads";
import { record } from "../../src/shared/values.ts";
import { localModelCatalog } from "./model-catalog.ts";
import { semanticModels } from "./semantic-models.ts";
import { type Extractor,type LoadState,type Reranker,type SemanticModel } from "./semantic-types.ts";
export { SEMANTIC_MODELS } from "./semantic-models.ts";

import { configureSemanticSettingsHooks,effectiveModel,ensureSemanticDirs,getSemanticSettings,MODEL_CACHE_ENV,modelById,modelCacheDir,semanticDataDir } from "./semantic-settings.ts";
export const IS_SEMANTIC_WORKER = !isMainThread && workerData?.role === "semantic-search";

export const SEARCH_STRATEGIES = ["lexical", "auto", "semantic", "deep"];
const LONG_TIMEOUT_STRATEGIES = new Set(["deep", "semantic"]);
export function normalizeSearchStrategy(input: string | undefined) {
  return SEARCH_STRATEGIES.includes(input ?? "") ? input! : "semantic";
}
export function usesLongTimeout(strategy: string) {
  return LONG_TIMEOUT_STRATEGIES.has(strategy);
}

export const embeddingPipelines = new Map<string, Extractor>();
const rerankers = new Map<string, Reranker>();
const loadingByModel = new Map<string, Promise<{ embedding: Extractor | undefined; reranker: Reranker | null }>>();
export const queryEmbeddingCache = new Map<string, number[]>();
export const documentEmbeddingCache = new Map<string, number[]>();
let deepIdleTimer: ReturnType<typeof setTimeout> | null = null;

export const loadState: LoadState = {
  state: "idle",
  modelId: null,
  component: null,
  startedAt: null,
  completedAt: null,
  error: null,
  file: null,
  progress: null,
};

let semanticWorker: Worker|null = null;
let semanticWorkerDir: string|null = null;
let semanticWorkerRequestId = 1;
const semanticWorkerPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
export function nowIso() {
  return new Date().toISOString();
}

export function semanticWorkerInstance() {
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

export function semanticWorkerRequest(method: string, params: Record<string, unknown> = {}, timeoutMs: number = 900000) {
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

export async function configureTransformersCache() {
  const runtime = await import("@huggingface/transformers");
  const { env } = runtime;
  ensureSemanticDirs();
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  // Remote model files are only used for first-time downloads. Inference runs locally.
  env.allowRemoteModels = true;
  return runtime;
}

export function updateLoadState(patch: Partial<LoadState>) {
  Object.assign(loadState, patch);
}

export function progressFor(model: SemanticModel, component: string) {
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

export async function disposeMaybe(value: { dispose?(): Promise<unknown> } | null | undefined) {
  if (value && typeof value.dispose === "function") await value.dispose();
}

export function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  if (value !== undefined) cache.set(key, value);
  return value;
}

export function lruSet<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) { const first = cache.keys().next(); if (first.done) break; cache.delete(first.value); }
}

export async function unloadModelsExcept(modelId: string) {
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

export function scheduleDeepUnload(modelId: string) {
  if (deepIdleTimer) clearTimeout(deepIdleTimer);
  deepIdleTimer = setTimeout(() => {
    const extractor = embeddingPipelines.get(modelId);
    const reranker = rerankers.get(modelId);
    embeddingPipelines.delete(modelId);
    rerankers.delete(modelId);
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

export async function loadEmbedding(model: SemanticModel) {
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

export async function loadReranker(model: SemanticModel) {
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

export async function prepareSemanticModelLocal(modelId = getSemanticSettings().modelId) {
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

export function cachePathForModelId(modelId: string) {
  return path.join(modelCacheDir(), ...modelId.split("/"));
}

export function removeEmptyParentDirs(filePath: string) {
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

export function cacheInfoForModel(model: SemanticModel) {
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

export function semanticModelsStatus() {
  return semanticModels().map((model) => {
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
    catalogStatus: localModelCatalog().status,
    cache: { kind: "local" },
    load: { ...loadState },
    runtime: { backend: "onnxruntime-node", intraOpThreads: 4, interOpThreads: 1, maxLoadedModels: 1, deepIdleMs: 120000 },
  };
}

export async function deleteSemanticModelLocal(modelId = getSemanticSettings().modelId) {
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


export function semanticWorkerActive() { return semanticWorker !== null; }
export function tokenId(tokenizer: PreTrainedTokenizer, token: string): number {
  const encoded = tokenizer.encode(token, { add_special_tokens: false });
  const value = Array.isArray(encoded) ? encoded[0] : Array.from(encoded as ArrayLike<number>)[0];
  if (!Number.isInteger(value)) throw new Error(`Tokenizer has no token for ${token}`);
  return Number(value);
}
configureSemanticSettingsHooks({
  preload: async (modelId) => { await prepareSemanticModel(modelId); },
  status: semanticStatus,
});
