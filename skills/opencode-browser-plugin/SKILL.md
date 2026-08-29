---
name: opencode-browser-plugin
description: Use the provider-neutral browser runtime through its four MCP or OpenCode tools.
---

# opencode-browser-plugin

Prefer a structured connector or API when it can complete the task. Use these browser tools for UI-only work, connector gaps, and visual verification. Do not switch to raw Node, Playwright, or another browser integration when this runtime is available.

Use `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Pass a user-named profile on the first useful call. Avoid status-only calls. Combine find, action, conditional settling, and post-observation in one `browser_run`; never synthesize fixed-delay wait steps.

Reuse `sessionId`. Page search uses the Snowflake model by default. Pass `searchStrategy: "lexical"` for lowest latency, `"auto"` for lexical-first adaptive retrieval, or `"deep"` for multilingual, code-heavy, or genuinely semantic retrieval. Request advanced descriptions with `browser_observe` mode `capabilities`, then execute a capability through a `browser_run` step without adding top-level tools.

Choose the browser surface deliberately. An explicit user request for a named profile or browser wins over URL-based selection; when no profile is named, let the target URL select the profile; with neither, use the default profile. Selection and discovery stay read-only — never inspect cookies, storage, profiles, passwords, or session stores. When authentication blocks a requested navigation, ask the user to sign in directly in their browser; do not substitute another profile or bypass the sign-in with a search engine, a mirror site, or any other source.

When browser setup succeeds but discovery or selection fails, read `docs/troubleshooting.md` — topic `#discovery` — before retrying. When extension or native-host installation or communication fails, read `#installation` before taking another recovery action.

When the user asks to continue, resume, or recall what a prior session did — or when the target describes a reasonably repeatable multi-step workflow (logins aside) that you or a previous run already attempted — consult local action memory instead of re-exploring from scratch: call `memory_status` first, then one bounded `memory_search "<task intent>"` (and `memory_query` only for provenance) before broader page or tab discovery. `memory_search` returns at most three high-level recipes and already rejects unrelated matches; if a returned recipe fits, prefer replaying it through `browser_run` with `memoryMode: "auto"` and `memoryIntent: "<task intent>"` — the runtime re-resolves each remembered target against the live DOM through the ordinary execution path and falls back to normal exploration automatically when a step is stale. Typed values and URLs always come from your own request, never from memory. Treat results as evidence, not a transcript: reuse confirmed routes, treat returned negative lessons as what failed, verify current page state through the least intrusive observation, and ask the user when intent is missing. Never consult memory for unrelated tasks, and continue normally when memory is absent, disabled, unhealthy, or search returns nothing.

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

When a result is `approval_required`, review the chain and call `browser_run` again with only `approvalToken`. Never recreate or modify the approved chain. Retrieve screenshots and oversized results from their artifact URI. When the work is complete, call `browser_finalize` and pass `keep` only for tabs that must survive:

- `{"tabId": <id>, "status": "deliverable"}` — the live tab itself is the user-facing output: a created or edited document, spreadsheet, dashboard, checkout, submitted form result, or a page the user explicitly asked to keep open. Deliverables move into the blue **OpenCode Deliverables** group.
- `{"tabId": <id>, "status": "handoff"}` (the default when a status is omitted) — work must continue from the live page in a later turn: a page waiting for user input, login, approval, payment, CAPTCHA, or an unfinished workflow. Handoffs stay inside the session's green group and remain available in later turns; mark them again at the end of that later turn if they must survive it too, because the latest mark per tab wins.
- Do not keep research, search, source, intermediate, duplicate, blank, or error pages. Extract what you need and let finalize close them.
- Agent-created tabs that are not kept are closed; user-claimed tabs that are not kept are released without closing.

Hover elements with a `hover` step to reveal menus and tooltips before clicking. Accept or dismiss JavaScript dialogs with `handleDialog` (`value: "accept" | "dismiss"`, optional `promptText`); accepting a dialog pauses the chain for approval. Capture screenshots as `png`, `jpeg`, or `webp` with an optional `quality` for the compressed formats; screenshots are delivered inline as viewable images (use `fullPage: true` for the entire scrollable page, the default captures the visible viewport). Pending dialogs appear in the `dialogs` bucket of `browser_observe` mode `events`.

Apply persistent test environments with `browser_session` action `configure` — viewport, network preset or conditions, CPU throttling, geolocation, color scheme, user agent, custom headers, or `initScripts` — then `reset: true` or finalize clears them. Ask for source-mapped console stacks with `browser_console_logs` `sourceMap: true` (or the advanced diagnostics capability path), and drill into a single network request with `browser_observe` mode `inspect` and `target.requestId`.

Record local performance traces through `browser_observe` mode `diagnostic` with `diagnostic.type: "performance"` and `action: "record"`; the raw trace is stored as an artifact and the summary returns LCP, CLS, long tasks, blocking time, and more. Re-analyze a stored trace with `action: "inspect"`. Performance analysis is local-only: field data (CrUX) is never consulted.

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
