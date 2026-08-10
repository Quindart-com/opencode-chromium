# Context optimization

Use one `browser_run` for find, action, conditional settle, and post-observation. Use `fromStep` references rather than returning a fresh target to the model. Keep observations lean or compact and set `detail: "debug"` only when diagnosing.

Search uses Snowflake retrieval by default and omits embedding/reranker internals from ordinary responses. Pass `searchStrategy: "lexical"` or `"auto"` when a faster lexical path is preferred, or `"deep"` for Qwen retrieval/reranking. Accessibility trees, network events, console events, visual maps, and large DOM results are projected before the 4,096-character response budget is applied. Screenshots and oversized results are stored as artifacts.

Request an advanced capability manifest through `browser_observe` mode `capabilities`; execute it through a `capability` step without increasing the top-level tool count.

Deep network inspection is intentionally a lazy `network` pack, not a fifth default tool. Ask for `{"mode":"capabilities","pack":"network"}` only when a tab needs request/response debugging, then execute `network.inspect`. Its default output is a bounded lifecycle projection; headers are opt-in and redacted, bodies are opt-in, bounded, redacted, and approval-gated.
