---
name: opencode-browser-adapter
description: Control a connected Chromium profile efficiently with the four OpenCode Browser v0.2 tools.
---

# Chromium Agent Browser v0.2

## Choose the right surface first

Prefer a native connector or API for structured Airtable, Stripe, Gmail, Calendar, and similar operations. Use this browser for UI-only settings, connector gaps, or visual verification. If these tools are available, do not switch to raw Node, Playwright, or another browser integration.

## Minimize calls

Use `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. Do not make an initial status call. When the user names a profile, pass it to the first useful call; `browser_session {"action":"open","profile":"Work"}` returns tabs immediately when tab selection is actually needed.

Combine find, action, conditional settle, and verification in one `browser_run`. Use `postObserve` instead of click, delay, then observe. There is no blind `wait` action. Navigation and clicks receive a short automatic DOM settle; provide `settle` only for a specific `exists`, `not-exists`, `contains`, or `dom-quiet` condition.

Use `value` for all action text, including `type`, `replaceText`, and `clipboardWrite`. Prefer verified `replaceText` for inputs, contenteditable, Monaco-style editors, and covered editor controls. Key names are case-insensitive.

Search defaults to `searchStrategy: "auto"`: unique lexical matches return immediately and uncertain matches use the lightweight model only when ready. Use `lexical` for exact UI text and `deep` only for genuinely semantic, multilingual, or code-heavy retrieval. For an explicitly deep call likely to exceed ten seconds, give the wrapper a longer initial yield; do not create repeated wrapper `wait` calls.

If a chain returns `approval_required`, review it and send a new `browser_run` containing only `approvalToken`. The server executes the immutable stored request. Call `browser_finalize` when finished and retain only user-facing deliverables.

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
