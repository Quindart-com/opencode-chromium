# Semantic search

Retrieval strategies are decoupled from model identity:

| Strategy | Behavior |
| --- | --- |
| `lexical` | No embeddings; lexical ranking only. |
| `auto` (default) | Lexical first; escalates to the active adaptive embedding model when lexical ranking is not confident. |
| `semantic` | Always uses the active adaptive embedding model. |
| `deep` | Qwen3 embedding + reranker. |

`"snowflake"` remains a deprecated alias for `"semantic"` and will be removed
in a future release. Page search (`browser_observe` with `mode: "search"`, or
a `find`/`search` action) defaults to `auto` and returns at most five lean
results unless the caller asks otherwise. Inspect, visual, screenshot,
console, and network observations do not invoke page search. If the active
model is unavailable or disabled, the runtime returns useful lexical results
with `degraded: true`.

## Models

The local model registry currently ships four models:

| Model | Role | Size | Dimensions | Notes |
| --- | --- | --- | --- | --- |
| Snowflake Arctic Embed XS | Adaptive (default) | 22.6M | 384 | Compact default; the safest latency/quality trade-off. |
| Snowflake Arctic Embed M | Adaptive (optional) | 108.9M | 768 | Stronger relevance at 768 dimensions; larger disk and memory footprint. |
| Google EmbeddingGemma 300M | Adaptive (optional) | 308M | 128/256/512/768 (MRL) | Compact multilingual on-device model with a 2K context and Matryoshka output dimensions. 256 dimensions is the default and recommended balance. |
| Qwen3 0.6B Retrieval + Reranker | Deep | 0.6B + 0.6B | 1024 | Embedding plus reranker for multilingual, code-heavy, or genuinely semantic tasks; loaded on demand by deep search only. |

EmbeddingGemma uses a dedicated adapter: it reads the model's
`sentence_embedding` output, applies task-specific query/document prompts
(`task: search result | query: …` / `title: none | text: …`), truncates to the
configured Matryoshka dimensions, and re-normalizes. Supported dtypes are q4
and q8; fp16 is not supported by the ONNX export.

Any adaptive model can be the active retrieval model; pick one in the
extension popup (Connection → Semantic page search) or persist it with
`semantic.setSettings` (`modelId`, and `embeddingDims` for EmbeddingGemma).
Selecting a deep model as the active retrieval model is rejected — deep models
are reserved for `strategy: "deep"`. Settings invalid or missing entries fall
back to Snowflake XS.

## Embedding identity

Vectors are identified by an `embedding_profile` of
`model:dtype:dims:prompt-version` (for example
`embeddinggemma-300m:q4:d256:prompt-v1`). Vectors from different profiles are
never compared: switching models or dimensions marks stored vectors stale and
`opencode-chromium memory reindex` (or the popup's "Rebuild memory index")
rebuilds them.

## Result contract

Search results follow a canonical serializer:

- **lean** (default) — `node_id`, `kind`, `label`, `role`, `interactive`;
  a selector is included only when no node reference exists. Never
  bounding boxes, coordinates, heading paths, landmarks, or ranking internals.
- **compact** — adds `selector`, short `text`, and the final relevance score.
- **debug** — full diagnostics including bounding boxes and score components.

The response carries model metadata once at the top level, not per result.

Qwen retrieval and reranking are explicit deep-search behavior for
multilingual, code-heavy, or genuinely semantic tasks. Only one semantic model
is loaded at a time; deep models unload after idle time. Model files live
outside the extension service worker, use local CPU inference, and are cached
locally (`OPENCODE_BROWSER_SEMANTIC_DIR`, with the legacy environment alias
supported). The extension popup manages each model's local cache: download,
re-download, and delete are per-model actions with live progress.

Model downloads are never triggered by ordinary lexical search. `doctor`
reports cache readiness; integration benchmarks are opt-in and do not run
during unit tests.
