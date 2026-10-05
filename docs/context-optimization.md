# Context optimization

Use one `browser_run` for find, action, conditional settle, and post-observation. Use `fromStep` references rather than returning a fresh target to the model. Keep observations lean or compact and set `detail: "debug"` only when diagnosing.

Failures are bounded on purpose. A failed step reports the error code, a message clipped to 240 characters, and one actionable hint; the payload a failed step already produced is not repeated, and stack frames and newlines are stripped because a model cannot use them. A step that never acted is not re-observed: an automatic page read only happens when the outcome is genuinely uncertain, the action can mutate the page, and the step named a target, and it is capped at five nodes. A rejected step therefore stays around 440 characters instead of nearly 900.

Observations and search units are emitted as lean summaries: `node_id`, `kind`, `text`, `selector`, `boundingBox`, `interactive`, and `inViewport` are always present, while `role`, `name`, `type`, `placeholder`, `disabled`, `headingPath`, and `landmark` appear only when meaningful. `tagName`, `visible`, `screenshotClip`, and duplicated ancestor/context text are omitted, and the verbose `target.html` and `target.styles` fields are reserved for `detail: "debug"`. Empty contract fields such as `extensionVersion` and `nativeHostVersion` are omitted from responses.

Search uses Snowflake retrieval by default and omits embedding/reranker internals from ordinary responses. Pass `searchStrategy: "lexical"` or `"auto"` when a faster lexical path is preferred, or `"deep"` for Qwen retrieval/reranking. Accessibility trees, network events, console events, visual maps, and large DOM results are projected before the 4,096-character response budget is applied. Screenshots and oversized results are stored as artifacts.

Request an advanced capability manifest through `browser_observe` mode `capabilities`; execute it through a `capability` step without increasing the top-level tool count.

Deep network inspection is intentionally a lazy `network` pack, not a fifth default tool. Ask for `{"mode":"capabilities","pack":"network"}` only when a tab needs request/response debugging, then execute `network.inspect`. Its default output is a bounded lifecycle projection; headers are opt-in and redacted, bodies are opt-in, bounded, redacted, and approval-gated.