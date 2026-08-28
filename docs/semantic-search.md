# Semantic search

Page search uses Snowflake Arctic Embed XS by default. Pass `searchStrategy: "lexical"` when the lowest latency is preferred, `"auto"` for lexical-first adaptive retrieval, or `"deep"` for the explicit Qwen embedding/reranker path. If the default model is unavailable or disabled, the runtime returns useful lexical results with `degraded: true`. Snowflake is used by page search (`browser_observe` with `mode: "search"` or a search action), not by every observation mode: inspect, visual, screenshot, console, and network observations do not invoke Snowflake.

## Models

The local model registry currently ships three models:

| Model | Role | Size | Dimensions | Notes |
| --- | --- | --- | --- | --- |
| Snowflake Arctic Embed XS | Adaptive (default) | 22.6M | 384 | Compact default; the safest latency/quality trade-off. |
| Snowflake Arctic Embed M | Adaptive (optional) | 108.9M | 768 | Stronger relevance at 768 dimensions; larger disk and memory footprint. |
| Qwen3 0.6B Retrieval + Reranker | Deep | 0.6B + 0.6B | 1024 | Embedding plus reranker for multilingual, code-heavy, or genuinely semantic tasks; loaded on demand by deep search only. |

Any adaptive model can be the active retrieval model; pick one in the extension popup (Connection → Semantic page search) or persist it with `semantic.setSettings` (`modelId`). Selecting a deep model as the active retrieval model is rejected — deep models are reserved for `searchStrategy: "deep"`. Settings invalid or missing entries fall back to Snowflake XS.

The returned compact search metadata reports `model.used`, so callers can distinguish a lexical result from a result that actually used the embedding model. The default Snowflake strategy waits for model preparation; `auto` may return lexical results while its model is preparing. Explicit `searchStrategy: "deep"` selects the Qwen embedding/reranker path instead.

Qwen retrieval and reranking are explicit deep-search behavior for multilingual, code-heavy, or genuinely semantic tasks. Only one semantic model is loaded at a time; deep models unload after idle time. Model files live outside the extension service worker, use local CPU inference, and are cached under `AGENT_BROWSER_SEMANTIC_DIR` (with the legacy environment alias supported). The extension popup manages each model's local cache: download, re-download, and delete are per-model actions with live progress.

Model downloads are never triggered by ordinary lexical search. `doctor` reports cache readiness; integration benchmarks are opt-in and do not run during unit tests.
