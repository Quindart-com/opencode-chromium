import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { AutoModelForCausalLM, AutoTokenizer, env, pipeline } from "@huggingface/transformers";

const SETTINGS_VERSION = 3;
const DEFAULT_MODEL_ID = "snowflake-arctic-embed-xs";
const DEEP_MODEL_ID = "qwen3-0.6b-retrieval";
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_UNITS = 700;
const DEFAULT_EMBEDDING_CANDIDATES = 48;
const DEFAULT_RERANK_CANDIDATES = 8;
const MODEL_CACHE_ENV = "OPENCODE_BROWSER_SEMANTIC_DIR";
const IS_SEMANTIC_WORKER = !isMainThread && workerData?.role === "semantic-search";

const LEGACY_MODEL_IDS = new Set([
  "Xenova/bge-small-en-v1.5",
  "Xenova/all-MiniLM-L6-v2",
]);

export const SEMANTIC_MODELS = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Snowflake Arctic Embed XS",
    description: "Adaptive English page retrieval. Lexical search returns immediately when confident; this 22.6M parameter model only ranks uncertain candidates.",
    parameters: "22.6M",
    contextLength: "512",
    dimensions: 384,
    role: "adaptive",
    embedding: {
      id: "Snowflake/snowflake-arctic-embed-xs",
      baseModel: "Snowflake/snowflake-arctic-embed-xs",
      dtype: "q8",
      pooling: "cls",
      dimensions: 384,
      parameters: "22.6M",
      queryPrefix: "Represent this sentence for searching relevant passages: ",
    },
    benchmark: {
      label: "Model-card retrieval benchmark",
      value: "Stronger than base MiniLM at the same size class",
      note: "Browser-specific latency and recall are verified by local fixtures.",
    },
  },
  {
    id: DEEP_MODEL_ID,
    label: "Qwen3 0.6B Retrieval + Reranker",
    description: "Current local retrieval stack: Qwen3 embeddings for broad page search plus Qwen3 reranking for the final relevant context.",
    parameters: "0.6B embedding + 0.6B reranker",
    contextLength: "32k",
    dimensions: 1024,
    role: "deep",
    embedding: {
      id: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
      baseModel: "Qwen/Qwen3-Embedding-0.6B",
      dtype: "q8",
      pooling: "last_token",
      dimensions: 1024,
      parameters: "0.6B",
      task: "Given a browser automation task, retrieve relevant page elements, controls, content sections, and nearby context",
    },
    reranker: {
      id: "onnx-community/Qwen3-Reranker-0.6B-ONNX",
      baseModel: "Qwen/Qwen3-Reranker-0.6B",
      dtype: "q4",
      fallbackDtype: "q8",
      parameters: "0.6B",
      maxLength: 2048,
      instruction: "Given a browser automation task, rank page elements, controls, content sections, and nearby context by relevance",
    },
    benchmark: {
      label: "MTEB Eng v2 embedding / MTEB-R reranker",
      value: "70.70 / 65.80",
      note: "Embedding and reranking benchmarks, not a browser-control benchmark.",
    },
  },
];

const embeddingPipelines = new Map();
const rerankers = new Map();
const loadingByModel = new Map();
const queryEmbeddingCache = new Map();
const documentEmbeddingCache = new Map();
let deepIdleTimer = null;

const loadState = {
  state: "idle",
  modelId: null,
  component: null,
  startedAt: null,
  completedAt: null,
  error: null,
  file: null,
  progress: null,
};

let settingsCache = null;
let settingsCachePath = null;
let semanticWorker = null;
let semanticWorkerDir = null;
let semanticWorkerRequestId = 1;
const semanticWorkerPending = new Map();

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
  semanticWorker = new Worker(new URL("./semantic-search.js", import.meta.url), {
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
  const reset = (error) => {
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

function semanticWorkerRequest(method, params = {}, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const worker = semanticWorkerInstance();
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

function modelById(modelId) {
  if (LEGACY_MODEL_IDS.has(modelId)) return SEMANTIC_MODELS[0];
  return SEMANTIC_MODELS.find((model) => model.id === modelId) ?? SEMANTIC_MODELS[0];
}

function normalizeSettings(value = {}) {
  const enabled = value.enabled === true;
  return {
    version: SETTINGS_VERSION,
    enabled,
    strategy: enabled ? "auto" : "lexical",
    modelId: DEFAULT_MODEL_ID,
    deepModelId: DEEP_MODEL_ID,
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
  ensureSemanticDirs();
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

export function getSemanticSettings() {
  const filePath = settingsPath();
  if (!settingsCache || settingsCachePath !== filePath) {
    settingsCache = normalizeSettings(readJsonIfPresent(filePath) ?? {});
    settingsCachePath = filePath;
  }
  return settingsCache;
}

export function setSemanticSettings(input = {}) {
  const next = normalizeSettings({ ...getSemanticSettings(), ...input });
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

function configureTransformersCache() {
  ensureSemanticDirs();
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  // Remote model files are only used for first-time downloads. Inference runs locally.
  env.allowRemoteModels = true;
}

function updateLoadState(patch) {
  Object.assign(loadState, patch);
}

function progressFor(model, component) {
  return (progress) => {
    updateLoadState({
      state: "loading",
      modelId: model.id,
      component,
      file: typeof progress?.file === "string" ? progress.file : loadState.file,
      progress: Number.isFinite(progress?.progress) ? Math.round(progress.progress) : loadState.progress,
    });
  };
}

async function disposeMaybe(value) {
  if (value && typeof value.dispose === "function") await value.dispose();
}

function lruGet(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

async function unloadModelsExcept(modelId) {
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
  executionMode: "sequential",
};

async function loadEmbedding(model) {
  if (embeddingPipelines.has(model.id)) return embeddingPipelines.get(model.id);
  await unloadModelsExcept(model.id);
  configureTransformersCache();
  const extractor = await pipeline("feature-extraction", model.embedding.id, {
    dtype: model.embedding.dtype,
    session_options: ONNX_SESSION_OPTIONS,
    progress_callback: progressFor(model, "embedding"),
  });
  await unloadModelsExcept(model.id);
  embeddingPipelines.set(model.id, extractor);
  return extractor;
}

async function loadReranker(model) {
  if (!model.reranker) return null;
  if (rerankers.has(model.id)) return rerankers.get(model.id);
  configureTransformersCache();
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

function cachePathForModelId(modelId) {
  return path.join(modelCacheDir(), ...modelId.split("/"));
}

function removeEmptyParentDirs(filePath) {
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

function cacheInfoForModel(model) {
  const components = [model.embedding, model.reranker].filter(Boolean);
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
  return SEMANTIC_MODELS.map((model) => ({
    ...model,
    cache: cacheInfoForModel(model),
  }));
}

export function semanticStatus() {
  const settings = getSemanticSettings();
  return {
    settings,
    models: semanticModelsStatus(),
    cacheDir: modelCacheDir(),
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
  for (const modelFileId of [model.embedding.id, model.reranker?.id].filter(Boolean)) {
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

function compactString(value, max = 500) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function unitText(unit) {
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
  return compactString(parts.filter(Boolean).join(" | "), 1200);
}

function tokenize(value) {
  return compactString(value, 2000).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

function lexicalScore(query, text) {
  const normalizedQuery = compactString(query).toLowerCase();
  const normalizedText = compactString(text, 2000).toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;

  const queryTokens = [...new Set(tokenize(normalizedQuery))];
  if (!queryTokens.length) return normalizedText.includes(normalizedQuery) ? 0.7 : 0;

  const textTokens = new Set(tokenize(normalizedText));
  const matches = queryTokens.filter((token) => textTokens.has(token)).length;
  const overlap = matches / queryTokens.length;
  const phrase = normalizedText.includes(normalizedQuery) ? 0.35 : 0;
  const partial = queryTokens.some((token) => normalizedText.includes(token)) ? 0.1 : 0;
  return Math.min(1, phrase + partial + overlap * 0.55);
}

function unitBoost(unit) {
  let boost = 0;
  if (unit.interactive) boost += 0.05;
  if (unit.inViewport) boost += 0.03;
  if (unit.disabled) boost -= 0.15;
  if (unit.kind === "heading") boost -= 0.02;
  return boost;
}

function dot(first, second) {
  let total = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) total += first[index] * second[index];
  return total;
}

function rowsFromTensor(tensor, expectedRows) {
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  const data = tensor?.data;
  if (!data || !dims.length) return [];
  const width = dims.at(-1);
  const rows = dims.length === 1 ? 1 : dims[0];
  const count = expectedRows ?? rows;
  const output = [];
  for (let row = 0; row < Math.min(rows, count); row += 1) {
    output.push(data.slice(row * width, row * width + width));
  }
  return output;
}

function modelQuery(model, query) {
  if (model.embedding.queryPrefix) return `${model.embedding.queryPrefix}${query}`;
  return `Instruct: ${model.embedding.task}\nQuery:${query}`;
}

async function embedTexts(extractor, texts, model) {
  const tensor = await extractor(texts, { pooling: model.embedding.pooling, normalize: true });
  return rowsFromTensor(tensor, Array.isArray(texts) ? texts.length : 1);
}

function embeddingCandidateIndexes(units, lexical, input = {}) {
  const limit = Number.isInteger(input.embeddingCandidates) && input.embeddingCandidates > 0
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

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

async function semanticScores(model, query, documents, indexes, pageFingerprint = "") {
  const extractor = await loadEmbedding(model);
  const queryKey = `${model.id}:${shortHash(query)}`;
  let queryEmbedding = lruGet(queryEmbeddingCache, queryKey);
  let queryCacheHit = true;
  if (!queryEmbedding) {
    [queryEmbedding] = await embedTexts(extractor, modelQuery(model, query), model);
    lruSet(queryEmbeddingCache, queryKey, queryEmbedding, 128);
    queryCacheHit = false;
  }
  const scores = Array(documents.length).fill(null);
  const embeddings = new Map();
  const missing = [];
  let documentCacheHits = 0;
  for (const index of indexes) {
    const key = `${model.id}:${shortHash(pageFingerprint)}:${shortHash(documents[index])}`;
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
    const vectors = await embedTexts(extractor, batch.map((item) => documents[item.index]), model);
    vectors.forEach((embedding, offset) => {
      const item = batch[offset];
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

function tokenId(tokenizer, token) {
  if (typeof tokenizer.convert_tokens_to_ids === "function") {
    const id = tokenizer.convert_tokens_to_ids(token);
    if (Number.isInteger(id) && id >= 0) return id;
  }
  const encoded = tokenizer(token, { add_special_tokens: false });
  const data = encoded?.input_ids?.data ?? encoded?.input_ids;
  const value = Array.from(data ?? [])[0];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (Number.isInteger(number) && number >= 0) return number;
  throw new Error(`Could not resolve reranker token id for ${token}`);
}

function rerankerPrompt(model, query, document) {
  const system = "Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".";
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<Instruct>: ${model.reranker.instruction}\n\n<Query>: ${query}\n\n<Document>: ${document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

function lastTokenLogits(logits) {
  const dims = Array.isArray(logits?.dims) ? logits.dims : [];
  const data = logits?.data;
  if (!data || dims.length < 2) throw new Error("Reranker returned logits without tensor data");
  const vocabSize = dims.at(-1);
  const seqLen = dims.length === 3 ? dims[1] : dims[0];
  return data.slice((seqLen - 1) * vocabSize, seqLen * vocabSize);
}

async function rerankerScore(model, reranker, query, document) {
  const prompt = rerankerPrompt(model, query, compactString(document, 1800));
  const inputs = reranker.tokenizer(prompt, { truncation: true, max_length: model.reranker.maxLength });
  const output = await reranker.model(inputs);
  const logits = lastTokenLogits(output.logits);
  const yes = logits[reranker.yesTokenId];
  const no = logits[reranker.noTokenId];
  if (!Number.isFinite(yes) || !Number.isFinite(no)) throw new Error("Reranker did not return finite yes/no logits");
  const max = Math.max(yes, no);
  const yesExp = Math.exp(yes - max);
  const noExp = Math.exp(no - max);
  return yesExp / (yesExp + noExp);
}

async function rerankerScores(model, query, documents, rankedItems, input = {}) {
  const reranker = await loadReranker(model);
  const limit = Number.isInteger(input.rerankCandidates) && input.rerankCandidates > 0
    ? Math.min(input.rerankCandidates, 80)
    : DEFAULT_RERANK_CANDIDATES;
  const candidates = rankedItems.slice(0, limit);
  const scores = new Map();
  for (const item of candidates) {
    scores.set(item.unit.index, await rerankerScore(model, reranker, query, documents[item.unit.index]));
  }
  return { scores, count: candidates.length, dtype: reranker.dtype };
}

function normalizeUnits(units) {
  if (!Array.isArray(units)) return [];
  return units
    .slice(0, DEFAULT_MAX_UNITS)
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

function publicResult(unit, score, components) {
  return {
    node_id: unit.node_id ?? unit.nodeId ?? null,
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

function lexicalIsConfident(query, documents, ranked) {
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

function baseRanking(input = {}) {
  const query = compactString(input.query, 500);
  if (!query) throw new Error("semantic.rankPageUnits requires query");
  const maxResults = Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 100) : DEFAULT_MAX_RESULTS;
  const units = normalizeUnits(input.units);
  const documents = units.map(unitText);
  const lexical = documents.map((text, index) => lexicalScore(query, text) + unitBoost(units[index]));
  const ranked = units.map((unit, index) => ({
    unit,
    score: Math.max(0, Math.min(1, lexical[index] ?? 0)),
    lexical: Math.max(0, Math.min(1, lexical[index] ?? 0)),
    embedding: null,
    reranker: null,
  })).sort((first, second) => second.score - first.score);
  return { query, maxResults, units, documents, lexical, ranked };
}

function formatRanking(base, options = {}) {
  const ranked = (options.ranked ?? base.ranked).slice(0, base.maxResults);
  const model = options.model ?? modelById(DEFAULT_MODEL_ID);
  return {
    enabled: options.enabled ?? getSemanticSettings().enabled,
    mode: options.mode ?? "lexical",
    searchStrategy: options.searchStrategy ?? options.mode ?? "lexical",
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

async function rankPageUnitsLocal(input = {}) {
  const settings = getSemanticSettings();
  const requestedMode = ["auto", "deep", "lexical"].includes(input.mode)
    ? input.mode
    : ["hybrid", "semantic"].includes(input.mode) ? "deep" : "auto";
  const base = baseRanking(input);
  const confident = lexicalIsConfident(base.query, base.documents, base.ranked);
  if (requestedMode === "lexical" || !settings.enabled && requestedMode === "auto" || confident && requestedMode === "auto") {
    return formatRanking(base, { enabled: settings.enabled, mode: "lexical", searchStrategy: requestedMode });
  }

  const model = modelById(requestedMode === "deep" ? settings.deepModelId : settings.modelId);
  if (process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL === "1") {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedMode,
      degraded: true,
      degradationReason: "model-unavailable",
      model,
      modelError: "Semantic model loading is disabled",
    });
  }
  if (requestedMode === "auto" && !embeddingPipelines.has(model.id)) {
    void prepareSemanticModelLocal(model.id).catch(() => {});
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: "auto",
      degraded: true,
      degradationReason: loadState.state === "error" ? "model-unavailable" : "model-preparing",
      model,
      modelError: loadState.error,
    });
  }

  let embeddingResult;
  try {
    if (requestedMode === "deep") await prepareSemanticModelLocal(model.id);
    const indexes = embeddingCandidateIndexes(base.units, base.lexical, {
      ...input,
      embeddingCandidates: requestedMode === "deep" ? Math.min(input.embeddingCandidates ?? 120, 120) : Math.min(input.embeddingCandidates ?? 48, 48),
    });
    embeddingResult = await semanticScores(model, base.query, base.documents, indexes, input.pageFingerprint ?? "");
  } catch (error) {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedMode,
      degraded: true,
      degradationReason: "model-failure",
      model,
      modelError: error instanceof Error ? error.message : String(error),
    });
  }

  const preliminary = base.units.map((unit, index) => {
    const lexical = Math.max(0, Math.min(1, base.lexical[index] ?? 0));
    const embedding = embeddingResult.scores[index] ?? null;
    const score = embedding === null ? lexical : embedding * 0.72 + lexical * 0.28;
    return { unit, score, lexical, embedding, reranker: null };
  }).sort((first, second) => second.score - first.score);

  let ranked = preliminary;
  let rerankerUsed = false;
  let rerankerError = null;
  let rerankerCount = 0;
  let rerankerDtype = null;
  if (requestedMode === "deep" && model.reranker && preliminary.length > 0) {
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
  if (requestedMode === "deep") scheduleDeepUnload();

  return formatRanking(base, {
    enabled: settings.enabled,
    mode: requestedMode === "deep" ? "deep" : "adaptive",
    searchStrategy: requestedMode,
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

export async function rankPageUnits(input = {}) {
  return rankPageUnitsLocal(input);
}

export async function handleSemanticHostMethod(method, params = {}) {
  if (method === "semantic.workerStatus") return semanticStatus();
  if (method === "semantic.getSettings" || method === "semantic.status") {
    if (!IS_SEMANTIC_WORKER && semanticWorker) return semanticWorkerRequest("semantic.workerStatus", {}, 2000).catch(() => semanticStatus());
    return semanticStatus();
  }
  if (method === "semantic.listModels") return { models: semanticModelsStatus(), settings: getSemanticSettings(), cacheDir: modelCacheDir() };
  if (method === "semantic.setSettings") return setSemanticSettings(params);
  if (method === "semantic.prepareModel") {
    const settings = getSemanticSettings();
    const modelId = params.modelId ?? settings.modelId;
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
    if (IS_SEMANTIC_WORKER) return deleteSemanticModelLocal(params.modelId);
    return semanticWorkerRequest("semantic.deleteModel", { modelId: params.modelId });
  }
  if (method === "semantic.rankPageUnits") {
    if (IS_SEMANTIC_WORKER) return rankPageUnitsLocal(params);
    try {
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(250, Math.min(params.timeoutMs, params.mode === "deep" ? 60000 : 10000)) : 10000;
      return await semanticWorkerRequest("semantic.rankPageUnits", params, timeoutMs);
    } catch (error) {
      return formatRanking(baseRanking(params), {
        enabled: getSemanticSettings().enabled,
        mode: "lexical",
        searchStrategy: params.mode ?? "auto",
        degraded: true,
        degradationReason: /timed?\s*out/i.test(String(error)) ? "semantic-timeout" : "semantic-worker-failure",
        model: modelById(params.mode === "deep" ? DEEP_MODEL_ID : DEFAULT_MODEL_ID),
        modelError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return undefined;
}

if (IS_SEMANTIC_WORKER) {
  parentPort.on("message", async (message) => {
    try {
      const result = await handleSemanticHostMethod(message.method, message.params ?? {});
      parentPort.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
