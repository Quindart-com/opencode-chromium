import { parentPort } from "node:worker_threads";
import { record } from "../../src/shared/values.ts";
import { embeddingResultSchema,type EmbeddingResult } from "./memory/embedding-service.ts";
import { embeddingInputSchema,rankInputSchema,settingsInputSchema,type EmbeddingInput } from "./semantic-types.ts";
export { SEMANTIC_MODELS } from "./semantic-models.ts";
export { rankPageUnits } from "./semantic-ranking.ts";
export { deleteSemanticModel,prepareSemanticModel,SEARCH_STRATEGIES,semanticStatus } from "./semantic-runtime.ts";
export { embeddingProfileFor,getSemanticSettings,semanticDataDir,semanticModelFor,setSemanticSettings,truncateAndRenormalize } from "./semantic-settings.ts";

import { baseRanking,embedTexts,formatRanking,modelQuery,rankPageUnitsLocal } from "./semantic-ranking.ts";
import { deleteSemanticModelLocal,IS_SEMANTIC_WORKER,loadEmbedding,normalizeSearchStrategy,nowIso,prepareSemanticModelLocal,semanticModelsStatus,semanticStatus,semanticWorkerActive,semanticWorkerRequest,updateLoadState,usesLongTimeout } from "./semantic-runtime.ts";
import { embeddingProfileFor,getSemanticSettings,modelById,modelCacheDir,semanticModelFor,setSemanticSettings } from "./semantic-settings.ts";

export async function embedMemoryTexts(texts: string[], { modelId = null, timeoutMs = 900000 }: { modelId?: string | null; timeoutMs?: number } = {}): Promise<EmbeddingResult> {
  return embeddingResultSchema.parse(await handleSemanticHostMethod("semantic.embedMemory", { texts, modelId, timeoutMs }));
}
export async function handleSemanticHostMethod(method: string, input: unknown = {}) {
  const params = record(input);
  if (method === "semantic.workerStatus") return semanticStatus();
  if (method === "semantic.getSettings" || method === "semantic.status") {
    if (!IS_SEMANTIC_WORKER && semanticWorkerActive()) return semanticWorkerRequest("semantic.workerStatus", {}, 2000).catch(() => semanticStatus());
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
    const strategy = normalizeSearchStrategy(typeof params.mode === "string" ? params.mode : undefined);
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
        model: modelById(strategy === "deep" ? getSemanticSettings().deepModelId : getSemanticSettings().modelId),
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
