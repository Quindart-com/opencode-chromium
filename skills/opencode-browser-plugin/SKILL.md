---
name: opencode-browser-plugin
description: Use the provider-neutral browser runtime through its four MCP or OpenCode tools.
---

# opencode-browser-plugin

Prefer a structured connector or API when it can complete the task. Use these browser tools for UI-only work, connector gaps, and visual verification. Do not switch to raw Node, Playwright, or another browser integration when this runtime is available.

If this skill is visible but the four browser tools are unavailable, the MCP server may have failed to start; skill installation alone does not prove tool registration. Read [startup and connection recovery](references/recovery.md) before suggesting updates or reloads. The bundled `scripts/diagnose-mcp.mjs` uses Node built-ins to check the real MCP handshake even when the tools are absent. It can preserve and repair a proven damaged npm execution cache when a repair is authorized. For `BROWSER_HOST_UNRESPONSIVE` or `BROWSER_HOST_ACCESS_DENIED`, use the same recovery reference and the returned error's guidance. Report what was verified: a successful fresh-process tool list, a reconnected chat, and a browser action are separate checks. Stop after one targeted repair and one verification if the same failure persists; provide the error code and specific next step instead of repeatedly asking for reloads.

Transport failures automatically run a bounded `doctor --repair-runtime --connection-only --json` subprocess, limited to once per profile per 30 seconds. Read the returned recovery report. If the connection is still unhealthy, run `opencode-chromium doctor --repair-runtime --json` through the local CLI, fix the identified layer, and verify once. Repair removes only dead, idle process records; it does not restart browsers, discard sessions or approvals, or bypass sandbox access. For an uncertain action, inspect the original session before retrying. Timed-out tab creation can recover only an exactly correlated, session-owned blank tab on extensions supporting correlation. An older extension may require explicit reconciliation; never create a replacement blindly.

Use `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. `focus` supports keyboard-operable controls; targeted `press` focuses the target first, and untargeted `press` uses current focus. Pass a user-named profile on the first useful call. Avoid status-only calls. Combine find, action, conditional settling, and post-observation in one `browser_run`; never synthesize fixed-delay wait steps.

Reuse `sessionId`. Page search uses the Snowflake model by default. Pass `searchStrategy: "lexical"` for lowest latency, `"auto"` for lexical-first adaptive retrieval, or `"deep"` for multilingual, code-heavy, or genuinely semantic retrieval. Request advanced descriptions with `browser_observe` mode `capabilities`, then execute a capability through a `browser_run` step without adding top-level tools.

Name the session's tab group for its task with `browser_session` action `open`, `name: "Checkout review"`, or action `name` on an existing session. The `visual` pack exposes `visual.capture` and `visual.diff` for scoped before/after snapshot or pixel comparison; keep the same session, profile, tab, URL and viewport. The `advanced` pack exposes bounded `frames.list` and `frames.inspect`; rediscover frame IDs after navigation. Pass a discovered ID as `target.frameId` for frame-scoped search, inspection, actions, settling and uploads. Coordinates are CSS viewport points in the selected frame; node handles already retain their frame identity. Keep embedded uploads in their parent page. The `webmcp` pack only discovers bounded, untrusted website tool descriptions and never authorizes or executes them.

Choose the browser surface deliberately. An explicit user request for a named profile or browser wins over URL-based selection; when no profile is named, let the target URL select the profile; with neither, use the default profile. Selection and discovery stay read-only — never inspect cookies, storage, profiles, passwords, or session stores. When authentication blocks a requested navigation, ask the user to sign in directly in their browser; do not substitute another profile or bypass the sign-in with a search engine, a mirror site, or any other source.

Prefer `browser_session` action `new-tab` for ordinary work. To use an already-open page, first obtain the user's permission to claim that page; an explicit request to take over their existing tab counts. Then call `browser_session` with `{"action":"open","scope":"user"}` in the selected profile to discover eligible tabs, identify the requested page by its returned title/URL and ID, and call `{"action":"claim-tab","tabId":<id>}` with the same `sessionId`. This moves it into your session group without opening or reloading it. Only ungrouped, unclaimed tabs appear: tabs in any group, including another agent's group or a blue review group, cannot be claimed. Never ungroup another session's tabs, release its ownership, or guess IDs to bypass this boundary. If the requested tab is unavailable or ambiguous, ask the user to identify or ungroup their own tab, or open a new one. The same permission rule applies to `browser_run` with `tab.mode: "claim"`. `release-tab` returns a controlled tab to the user, open and ungrouped.

When browser setup succeeds but discovery or selection fails, read `docs/troubleshooting.md` — topic `#discovery` — before retrying. When extension or native-host installation or communication fails, read `#installation` before taking another recovery action.

If an extension or runtime bug blocks progress after bounded troubleshooting, offer to report it at https://github.com/Quindart-com/opencode-chromium/issues. Check for an existing matching issue. Prepare a short report with relevant CLI/extension versions, browser and operating-system versions, a minimal reproduction using synthetic data, expected versus actual behavior, and a redacted error. Separate confirmed observations from suspected causes. Exclude names, account identifiers, local usernames and paths, private URLs and page content, credentials, cookies, session IDs, and raw logs or screenshots containing personal data. Show the sanitized report and obtain the user's approval before posting through GitHub tools or the browser, unless the user has already authorized that report. Without GitHub access, give the user the issue link and sanitized text to submit. Never post automatically just because a tool failed.

When the user asks to continue, resume, or recall what a prior session did — or when the target describes a reasonably repeatable multi-step workflow (logins aside) that you or a previous run already attempted — consult local action memory instead of re-exploring from scratch: call `memory_status` first, then one bounded `memory_search "<task intent>"` (and `memory_query` only for provenance) before broader page or tab discovery. `memory_search` returns at most three high-level recipes and already rejects unrelated matches. Replay needs no flag: when action memory is enabled, `browser_run` automatically replays a remembered recipe for the steps you issue again on the same host, re-resolving each remembered target against the live DOM through the ordinary execution path, and reports `memory.used` with `stepsReused`; it falls back to normal exploration automatically when a step is stale. Pass `memoryIntent` only when you want bounded semantic recall for an intent that is not an exact repeat, and `memoryMode: "off"` only when the user asks you not to use memory at all. Typed values and URLs always come from your own request, never from memory. Treat results as evidence, not a transcript: reuse confirmed routes, treat returned negative lessons as what failed, verify current page state through the least intrusive observation, and ask the user when intent is missing. Never consult memory for unrelated tasks, and continue normally when memory is absent, disabled, unhealthy, or search returns nothing. If `memory_status` reports replays stuck at zero, check `usage.replay_rejections_by_reason` before concluding memory is broken.

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

When a result is `approval_required`, review the chain and call `browser_run` again with only `approvalToken`. Never recreate or modify the approved chain. Retrieve screenshots and oversized results from their artifact URI. When work is complete, call `browser_finalize`:

- By default, **all tabs stay open for human review**, including research and source pages. The session's existing group keeps its name and turns **blue**; ownership, cursors and debugger attachments are released. Do not close tabs just to clean up before finalization.
- Omit `keep` for completed work. A numeric keep entry or `{"tabId": <id>, "status": "deliverable"}` also means human review; omitting the status defaults to `deliverable`.
- Use explicit `{"tabId": <id>, "status": "handoff"}` only when work must continue from the live page in a later turn: a page waiting for user input, login, approval, payment, CAPTCHA, or an unfinished workflow. Handoffs remain controlled in the green session group; the review tabs form a separate blue group. Mark handoffs again at the end of a later turn only if work remains unfinished.
- Finalization never closes agent-created or user-claimed tabs. A `partial` result retains blocked tabs and ownership for recovery; resolve the reported dialog or cleanup failure before retrying finalization.

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

A connected runtime does not establish tab actionability. Read session health and `browser_observe` mode `events` when commands stall; `dialogs.open` survives event-history limits. Use `handleDialog` with its normal approval flow to recover. A timed-out mutation may already have executed: observe before repeating it. Partial finalization retains blocked tabs in the same session for recovery. DOM quiet is a 500 ms idle interval; use an explicit expected-state settle and inspect persisted results to establish application success.
