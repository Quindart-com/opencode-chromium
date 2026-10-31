import type { PreTrainedModel,PreTrainedTokenizer,Tensor } from "@huggingface/transformers";
import { z } from "zod";
export type ModelDtype = "q8" | "q4" | "fp16";
export interface SemanticModel {
  id: string; label: string; description: string; parameters: string; contextLength: string; dimensions: number; role: string; default?: boolean;
  embedding: { id: string; baseModel: string; dtype: ModelDtype; pooling: "cls" | "last_token" | "none"; dimensions: number; parameters: string;
    queryPrefix?: string; documentPrefix?: string; task?: string; adapter?: string; supportedDtypes?: ModelDtype[]; nativeDimensions?: number;
    supportedDimensions?: number[]; defaultDimensions?: number; promptVersion?: string };
  reranker?: { id: string; baseModel: string; dtype: ModelDtype; fallbackDtype?: ModelDtype; parameters: string; maxLength: number; instruction: string };
  benchmark?: { label: string; value: string; note: string };
}
export interface SemanticSettings { version: number; enabled: boolean; strategy: string; modelId: string; embeddingDims?: number;
  strategyPreference: string; agentResultCount: number; agentResultDetail: string; deepModelId: string }
export interface LoadState { state: string; modelId: string | null; component: string | null; startedAt: string | null; completedAt: string | null;
  error: string | null; file: string | null; progress: number | null }
export interface Extractor { (texts: string[], options?: { pooling?: "cls" | "last_token" | "none"; normalize?: boolean }): Promise<Tensor>; dispose?(): Promise<unknown> }
export interface Reranker { tokenizer: PreTrainedTokenizer; model: PreTrainedModel; dtype: ModelDtype; yesTokenId: number; noTokenId: number }
export const pageUnitSchema = z.object({
  frameId: z.string().max(300).optional(),
  node_id: z.union([z.number(), z.string()]).nullable().optional(), nodeId: z.union([z.number(), z.string()]).nullable().optional(),
  kind: z.string().optional(), tagName: z.string().nullable().optional(), role: z.string().nullable().optional(), name: z.string().nullable().optional(),
  ariaName: z.string().nullable().optional(), label: z.string().nullable().optional(), placeholder: z.string().nullable().optional(),
  text: z.string().nullable().optional(), headingPath: z.array(z.string()).nullable().optional(), landmark: z.string().nullable().optional(),
  selector: z.string().nullable().optional(), boundingBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
  interactive: z.boolean().optional(), inViewport: z.boolean().optional(), disabled: z.boolean().optional(),
});
export type PageUnit = z.infer<typeof pageUnitSchema>;
export type NormalizedUnit = PageUnit & { index: number; text: string; name: string; ariaName: string; label: string; placeholder: string; selector: string };
export interface RankedItem { unit: NormalizedUnit; score: number; lexical: number; embedding: number | null; reranker: number | null }
export const rankInputSchema = z.object({ query: z.string().nullable().optional(), units: z.array(z.unknown()).max(10000).optional(),
  mode: z.string().optional(), maxResults: z.number().optional(), embeddingCandidates: z.number().optional(), rerankCandidates: z.number().optional(),
  pageFingerprint: z.string().optional(), timeoutMs: z.number().optional() });
export type RankInput = z.infer<typeof rankInputSchema>;
export interface BaseRanking { query: string; maxResults: number; units: NormalizedUnit[]; documents: string[]; lexical: number[]; ranked: RankedItem[] }
export interface RankingOptions { enabled?: boolean; mode?: string; searchStrategy?: string; degraded?: boolean;
  degradationReason?: string | null; model?: SemanticModel; modelError?: string | null; ranked?: RankedItem[]; modelUsed?: boolean;
  rerankerUsed?: boolean; rerankerError?: string | null; rerankerCount?: number; rerankerDtype?: ModelDtype | null; cache?: { queryHit: boolean; documentHits: number } }
export const embeddingInputSchema = z.object({ texts: z.array(z.string()).max(128).default([]), modelId: z.string().nullable().optional(), timeoutMs: z.number().optional() });
export type EmbeddingInput = z.infer<typeof embeddingInputSchema>;
export const settingsInputSchema = z.object({ enabled: z.boolean().optional(), modelId: z.string().optional(), deepModelId: z.string().optional(), embeddingDims: z.number().optional(),
  strategyPreference: z.string().optional(), agentResultCount: z.number().optional(), agentResultDetail: z.string().optional(), preload: z.boolean().optional() });
export type SettingsInput = z.infer<typeof settingsInputSchema>;
