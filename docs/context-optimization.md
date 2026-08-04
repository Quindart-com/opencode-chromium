# Context Optimization

The core surface keeps browser context small in three layers: four tool definitions, chained actions that collapse model round trips, and task-shaped results instead of raw browser dumps. CI enforces an 8 KB serialized schema budget for every supported provider dialect.

## Default Inspection Flow

1. Use `browser_observe` with `mode: "search"` for named targets on large pages.
2. Use `mode: "visual"` when the agent needs visible boxes or coordinates.
3. Use `mode: "inspect"` for one selected node or selector.
4. Use `mode: "screenshot"` only when pixels are necessary; artifact delivery is the default.

Within a coherent operation, put `find` and the action that consumes it into one `browser_run` chain using `id` and `target.fromStep`. The runtime automatically ends the browser turn, avoiding an extra empty cleanup request.

Responses default to 4096 characters. Oversized JSON now keeps a budget-fitted, useful inline preview and adds an expiring artifact URI only for the optional complete result; it never replaces the observation with artifact metadata alone. Screenshots remain artifact-first unless inline image/base64 delivery is explicitly requested.

Core observe calls also constrain expansion before serialization: search defaults to 12 results, visual mapping to 25, lean inspection to one level and 12 children, network events are projected to request/response summaries, and raw accessibility trees receive a compact named-node preview. Callers can raise `limit`, `detail`, or `maxChars` deliberately.

## Lexical-first adaptive search

`searchStrategy: "auto"` returns immediately for a unique phrase or token match. Uncertain English matches rank at most 48 candidates with quantized `Snowflake/snowflake-arctic-embed-xs` on CPU ONNX. Document and query embeddings use bounded LRUs. A cold load, download failure, worker error, or semantic timeout returns useful lexical results with `degraded: true` while model preparation continues in the background.

`searchStrategy: "deep"` is explicit and retains the existing Qwen3 embedding/reranker cache for multilingual and code-heavy retrieval. Only one semantic model is loaded at a time, and the Qwen bundle unloads after two idle minutes. New installations download no model until adaptive retrieval is enabled.

Implementation references: [Snowflake Arctic Embed XS model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs), [Transformers.js quantized dtypes](https://huggingface.co/docs/transformers.js/en/guides/dtypes), and [Transformers.js ONNX backend](https://huggingface.co/docs/transformers.js/api/backends/onnx).

## Lean search output

`browser_page_search` defaults to:

- `detail: "lean"`: returns `node_id`, `kind`, `label`, and `interactive`.
- `scope: "auto"`: searches an active dialog/popover first when present.
- no Qwen model metadata, per-result scores, confidence values, or raw ranker components.

Use `detail: "compact"` for small model-use diagnostics, and `detail: "debug"` or `detail: "full"` when debugging ranking quality.

## Visual Map

`browser_visual_map` returns:

```json
{
  "elements": [
    {
      "node_id": "node-1",
      "kind": "button",
      "label": "Save settings",
      "box": { "x": 377, "y": 180, "width": 96, "height": 21 },
      "source": "dom"
    }
  ]
}
```

The default `vision: "auto"` path is DOM-first and does not load a model unless DOM mapping finds no elements. `vision: "force"` captures a local screenshot and asks the native host's optional detector for visual boxes. Lean output still strips scores; use `detail: "debug"` for model diagnostics.

`browser_page_search` and `browser_visual_map` preserve connected `node_id` mappings across consecutive calls. This allows a workflow such as visual map -> scoped page search -> inspect/click the original visual-map node. Detached nodes are pruned automatically.

## Model Boundaries

- Adaptive Snowflake and explicit-deep Qwen retrieval run in the native-host semantic worker and cache under `OPENCODE_BROWSER_SEMANTIC_DIR`.
- Optional screenshot detection runs in the native host and caches under `OPENCODE_BROWSER_VISUAL_DIR`.
- The extension service worker never runs model inference.
- Screenshot data used for model fallback is internal to the tool call and is not returned to the agent.
