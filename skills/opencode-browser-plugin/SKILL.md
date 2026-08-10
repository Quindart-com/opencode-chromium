---
name: opencode-browser-plugin
description: Use the provider-neutral browser runtime through its four MCP or OpenCode tools.
---

# opencode-browser-plugin

Prefer a structured connector or API when it can complete the task. Use these browser tools for UI-only work, connector gaps, and visual verification. Do not switch to raw Node, Playwright, or another browser integration when this runtime is available.

Use `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Pass a user-named profile on the first useful call. Avoid status-only calls. Combine find, action, conditional settling, and post-observation in one `browser_run`; never synthesize fixed-delay wait steps.

Reuse `sessionId`. Page search uses the Snowflake model by default. Pass `searchStrategy: "lexical"` for lowest latency, `"auto"` for lexical-first adaptive retrieval, or `"deep"` for multilingual, code-heavy, or genuinely semantic retrieval. Request advanced descriptions with `browser_observe` mode `capabilities`, then execute a capability through a `browser_run` step without adding top-level tools.

For deeper network inspection of one controlled tab, request the lazy network pack and then run `network.inspect`:

```json
{"mode":"capabilities","pack":"network"}
```

```json
{
  "steps": [{
    "action": "capability",
    "capability": "network.inspect",
    "input": {"tabId": 123, "urlIncludes": "/api/", "includeHeaders": true}
  }]
}
```

The default network result is lifecycle-only. Headers are redacted, bodies are disabled by default, and `includeBody: "request" | "response" | "both"` is bounded, redacted, and approval-gated.

When a result is `approval_required`, review the chain and call `browser_run` again with only `approvalToken`. Never recreate or modify the approved chain. Retrieve screenshots and oversized results from their artifact URI, and call `browser_finalize` when the work is complete while keeping only user-facing deliverables.

Hover elements with a `hover` step to reveal menus and tooltips before clicking. Accept or dismiss JavaScript dialogs with `handleDialog` (`value: "accept" | "dismiss"`, optional `promptText`); accepting a dialog pauses the chain for approval. Capture screenshots as `png`, `jpeg`, or `webp` with an optional `quality` for the compressed formats. Pending dialogs appear in the `dialogs` bucket of `browser_observe` mode `events`.

Apply persistent test environments with `browser_session` action `configure` — viewport, network preset or conditions, CPU throttling, geolocation, color scheme, user agent, custom headers, or `initScripts` — then `reset: true` or finalize clears them. Ask for source-mapped console stacks with `browser_console_logs` `sourceMap: true` (or the advanced diagnostics capability path), and drill into a single network request with `browser_observe` mode `inspect` and `target.requestId`.

```json
{
  "profile": "Work",
  "steps": [
    { "id": "settings", "action": "find", "value": "workspace settings" },
    { "action": "click", "target": { "fromStep": "settings" }, "settle": { "condition": "exists", "target": { "selector": "[role=dialog]" } } },
    { "action": "replaceText", "target": { "selector": "input[name=workspace]" }, "value": "New name" }
  ],
  "postObserve": { "mode": "inspect", "target": { "selector": "[role=dialog]" } }
}
```
