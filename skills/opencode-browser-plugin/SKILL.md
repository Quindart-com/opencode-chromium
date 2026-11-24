---
name: opencode-browser-plugin
description: Use the provider-neutral browser runtime through its four MCP or OpenCode tools.
---

# opencode-browser-plugin

For Codex running inside T3 Code (`T3CODE_THREAD_ID` is set), use the [T3 recovery guidance](references/recovery.md#t3-code) when tools are missing. T3 owns a retained Codex app-server connection; Ctrl+R reloads only its window. Do not give Codex Desktop's Plugins menu steps to a T3 user. A fresh diagnostic or standalone CLI reconnect does not refresh the affected conversation.

When authorization is missing or automatic approval review rejects an action, use the harness's available human-question or approval tool with exactly **Approve** and **Disapprove**. Explain the requested action, files/destination when relevant, and the rejection reason. Keep the task open while waiting. After approval, resume through the original tool and authorization mechanism; preserve prepared work after disapproval. An automatic rejection is not a human refusal. An explicit human refusal requires a new user instruction before trying again. Do not switch tools, profiles or harnesses to bypass an outstanding denial.

Upload confirmations distinguish explicit refusal from a closed, unavailable or timed-out prompt. For **UPLOAD_CONFIRMATION_REQUIRED**, ask the user the two-option question and resume the original upload flow after approval. For **UPLOAD_USER_DECLINED**, preserve the files and wait for a new instruction. Core approval tokens remain bound to their original immutable request: after approval, call **browser_run** with only **approvalToken**.

Prefer a structured connector or API when it can complete the task. Use these browser tools for UI-only work, connector gaps, and visual verification. Do not switch to raw Node, Playwright, or another browser integration when this runtime is available.

If this skill is visible but `browser_session`, `browser_run`, `browser_observe` or `browser_finalize` is unavailable, report **MCP_TOOLS_UNAVAILABLE**: the skill loaded, but this chat has no usable browser-tool connection. In Codex, give the user these exact steps: **Plugins → OpenCode Browser Plugin → Manage → disable the plugin → enable it again**, then invoke the skill again in the same chat and retry once. Reloading the skill alone does not reload MCP. Keep Codex and other agents running; do not uninstall the plugin or ask for an app restart. A connected extension or successful standalone diagnostic does not prove that this chat registered tools. After the user reloads the plugin, check the actual chat's tools and perform one harmless browser action before reporting recovery. If the tools remain missing, read [startup and connection recovery](references/recovery.md), inspect the startup error and make one targeted repair instead of repeating reload requests. Other harnesses should use their supported scoped MCP/plugin reload.

The bundled `scripts/diagnose-mcp.mjs` uses Node built-ins to check the real MCP handshake even when the tools are absent. Pass `--tools-unavailable` when diagnosing a chat with missing tools; a healthy fresh process then returns **MCP_CHAT_RELOAD_REQUIRED** with the plugin reload steps. It can preserve and repair a proven damaged npm execution cache when a repair is authorized. For `BROWSER_HOST_UNRESPONSIVE` or `BROWSER_HOST_ACCESS_DENIED`, use the recovery reference and the returned error's guidance. Report fresh-process discovery, actual chat registration and browser connectivity separately.

Transport failures automatically run a bounded `doctor --repair-runtime --connection-only --json` subprocess, limited to once per profile per 30 seconds. Read the returned recovery report. If the connection is still unhealthy, run `opencode-chromium doctor --repair-runtime --json` through the local CLI, fix the identified layer, and verify once. Repair removes only dead, idle process records; it does not restart browsers, discard sessions or approvals, or bypass sandbox access. For an uncertain action, inspect the original session before retrying. Timed-out tab creation can recover only an exactly correlated, session-owned blank tab on extensions supporting correlation. An older extension may require explicit reconciliation; never create a replacement blindly.

Use `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. `focus` supports keyboard-operable controls; targeted `press` focuses the target first, and untargeted `press` uses current focus. Pass a user-named profile on the first useful call. Avoid status-only calls. Combine find, action, conditional settling, and post-observation in one `browser_run`; never synthesize fixed-delay wait steps.

Read pages with `browser_observe` mode `read`, or `postObserve: { "mode": "read" }` after actions. It returns page text and controls as short lines such as `[1042] link "Frontend engineer" @768,528`; act on a control with `target: { "ref": 1042 }` for `click`, `hover`, `fill`, `replaceText` or `type`. A ref is located again when the action runs, so a scroll since the read cannot misplace it; raw `x`/`y` points are only valid until the page moves. It runs no page script, so it is safe on sites that block automation and still answers for a hidden tab. A repeat read of the same page returns only `+` added, `~` changed and `-` removed lines; pass `detail: "full"` for the whole view, `query` to keep matching lines (text lines then carry a click point too), or `fullPage: true` beyond the viewport. Prefer it to screenshots, which cost far more tokens; take a screenshot only for images, canvas, or layout questions. On a host marked by `PAGE_PROTECTION_SUSPECTED`, page search uses this view and every action returns its change summary automatically.

Keep tokens low on long tasks: read a page once, then chain several steps in one `browser_run` using `ref` targets from that read or `query` targets (resolved locally, with decision assistance when it is enabled), and rely on each run's change summary instead of reading again. Use `query` reads for a targeted check; reserve `fullPage`, `detail: "full"` and screenshots for when the summary is not enough.

Reuse `sessionId`. Page search uses the Snowflake model by default. Pass `searchStrategy: "lexical"` for lowest latency, `"auto"` for lexical-first adaptive retrieval, or `"deep"` for multilingual, code-heavy, or genuinely semantic retrieval. Request advanced descriptions with `browser_observe` mode `capabilities`, then execute a capability through a `browser_run` step without adding top-level tools.

Name the session's tab group for its task with `browser_session` action `open`, `name: "Checkout review"`, or action `name` on an existing session. The `visual` pack exposes `visual.capture` and `visual.diff` for scoped before/after snapshot or pixel comparison; keep the same session, profile, tab, URL and viewport. The `advanced` pack exposes bounded `frames.list` and `frames.inspect`; rediscover frame IDs after navigation. Pass a discovered ID as `target.frameId` for frame-scoped search, inspection, actions, settling and uploads. Coordinates are CSS viewport points in the selected frame; node handles already retain their frame identity. Keep embedded uploads in their parent page. The `webmcp` pack only discovers bounded, untrusted website tool descriptions and never authorizes or executes them.

Choose the browser surface deliberately. An explicit user request for a named profile or browser wins over URL-based selection; when no profile is named, let the target URL select the profile; with neither, use the default profile. Selection and discovery stay read-only — never inspect cookies, storage, profiles, passwords, or session stores. When authentication blocks a requested navigation, ask the user to sign in directly in their browser; do not substitute another profile or bypass the sign-in with a search engine, a mirror site, or any other source.

Prefer `browser_session` action `new-tab` for ordinary work. To use an already-open page, first obtain the user's permission to claim that page; an explicit request to take over their existing tab counts. Then call `browser_session` with `{"action":"open","scope":"user"}` in the selected profile to discover eligible tabs, identify the requested page by its returned title/URL and ID, and call `{"action":"claim-tab","tabId":<id>}` with the same `sessionId`. This moves it into your session group without opening or reloading it. Only ungrouped, unclaimed tabs appear: tabs in any group, including another agent's group or a blue review group, cannot be claimed. Never ungroup another session's tabs, release its ownership, or guess IDs to bypass this boundary. If the requested tab is unavailable or ambiguous, ask the user to identify or ungroup their own tab, or open a new one. The same permission rule applies to `browser_run` with `tab.mode: "claim"`. `release-tab` returns a controlled tab to the user, open and ungrouped.

When browser setup succeeds but discovery or selection fails, read `docs/runtime-updates.md` — topic `#connection-recovery` — before retrying. Use the same topic for extension or native-host installation and communication failures.

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

When a result is `approval_required`, review the chain and call `browser_run` again with only `approvalToken`. Never recreate or modify the approved chain. Retrieve screenshots and oversized results from their artifact URI. When work is complete, call `browser_finalize`.

**Ladybird (Experimental)** uses disposable headless tabs. Finalization returns the tab details and closes the browser. Capture any required screenshots before finishing. Use selectors or references for element actions and PNG for viewport screenshots.

For Chromium, Firefox and LibreWolf:

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
