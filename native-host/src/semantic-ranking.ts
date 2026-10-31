import type { PreTrainedTokenizer,Tensor } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { DEFAULT_MODEL_ID } from "./semantic-models.ts";
import { pageUnitSchema,type BaseRanking,type Extractor,type NormalizedUnit,type PageUnit,type RankedItem,type RankingOptions,type RankInput,type Reranker,type SemanticModel } from "./semantic-types.ts";
export { SEMANTIC_MODELS } from "./semantic-models.ts";

import { documentEmbeddingCache,embeddingPipelines,loadEmbedding,loadReranker,loadState,lruGet,lruSet,normalizeSearchStrategy,prepareSemanticModelLocal,queryEmbeddingCache,scheduleDeepUnload } from "./semantic-runtime.ts";
import { DEFAULT_EMBEDDING_CANDIDATES,DEFAULT_MAX_RESULTS,DEFAULT_MAX_UNITS,DEFAULT_RERANK_CANDIDATES,DISABLE_MODEL_ENV,embeddingProfileFor,getSemanticSettings,modelById,semanticModelFor,truncateAndRenormalize } from "./semantic-settings.ts";
export function compactString(value: unknown, max: number = 500) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

export function unitText(unit: PageUnit) {
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

export function tokenize(value: string) {
  return compactString(value, 2000).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

export function lexicalScore(normalizedQuery: string, queryTokens: string[], text: string) {
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

export function unitBoost(unit: PageUnit | undefined) {
  let boost = 0;
  if (unit?.interactive) boost += 0.05;
  if (unit?.inViewport) boost += 0.03;
  if (unit?.disabled) boost -= 0.15;
  if (unit?.kind === "heading") boost -= 0.02;
  return boost;
}

export function dot(first: ArrayLike<number>, second: ArrayLike<number>) {
  let total = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) total += (first[index] ?? 0) * (second[index] ?? 0);
  return total;
}

export function rowsFromTensor(tensor: Tensor, expectedRows: number) {
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

export function modelQuery(model: SemanticModel, query: string) {
  if (model.embedding.queryPrefix) return `${model.embedding.queryPrefix}${query}`;
  return `Instruct: ${model.embedding.task}\nQuery:${query}`;
}

export function modelDocument(model: SemanticModel, text: string) {
  if (model.embedding.documentPrefix) return `${model.embedding.documentPrefix}${text}`;
  return text;
}

export async function embedTexts(extractor: Extractor, texts: string | string[], model: SemanticModel) {
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

export function embeddingCandidateIndexes(units: NormalizedUnit[], lexical: number[], input: RankInput = {}) {
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

export function shortHash(value: string) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

export async function semanticScores(model: SemanticModel, query: string, documents: string[], indexes: number[], pageFingerprint: string = "") {
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

export function tokenId(tokenizer: PreTrainedTokenizer, token: string): number {
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

export function rerankerPrompt(model: SemanticModel, query: string, document: string) {
  if (!model.reranker) throw new Error("No reranker is configured");
  const system = "Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".";
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<Instruct>: ${model.reranker.instruction}\n\n<Query>: ${query}\n\n<Document>: ${document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

export function lastTokenLogits(logits: Tensor) {
  const dims = Array.isArray(logits?.dims) ? logits.dims : [];
  const data = logits?.data;
  if (!data || dims.length < 2) throw new Error("Reranker returned logits without tensor data");
  const vocabSize = dims.at(-1) ?? 0;
  const seqLen = (dims.length === 3 ? dims[1] : dims[0]) ?? 0;
  return Array.from(data.slice((seqLen - 1) * vocabSize, seqLen * vocabSize), Number);
}

export async function rerankerScore(model: SemanticModel, reranker: Reranker, query: string, document: string) {
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

export async function rerankerScores(model: SemanticModel, query: string, documents: string[], rankedItems: RankedItem[], input: RankInput = {}) {
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

export function normalizeUnits(units: unknown[] | undefined) {
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

export function publicResult(unit: PageUnit, score: number, components: { lexical: number; embedding: number | null; reranker: number | null }) {
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

export function lexicalIsConfident(query: string, documents: string[], ranked: RankedItem[]) {
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

export function baseRanking(input: RankInput = {}) {
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

export function formatRanking(base: BaseRanking, options: RankingOptions = {}) {
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

export async function rankPageUnitsLocal(input: RankInput = {}) {
  const settings = getSemanticSettings();
  const requestedStrategy = normalizeSearchStrategy(input.mode);
  const base = baseRanking(input);
  if (requestedStrategy === "lexical" || requestedStrategy === "auto" &&
    (!settings.enabled || lexicalIsConfident(base.query, base.documents, base.ranked))) {
    return formatRanking(base, { enabled: settings.enabled, mode: "lexical", searchStrategy: requestedStrategy });
  }

  const model = semanticModelFor(requestedStrategy === "deep" ? settings.deepModelId : settings.modelId, settings);
  if (requestedStrategy === "semantic" && !settings.enabled) {
    return formatRanking(base, {
      enabled: settings.enabled,
      mode: "lexical",
      searchStrategy: requestedStrategy,
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
  if (requestedStrategy === "deep") scheduleDeepUnload(model.id);

  return formatRanking(base, {
    enabled: settings.enabled,
    mode: requestedStrategy === "deep" ? "deep" : "adaptive",
    searchStrategy: requestedStrategy,
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
