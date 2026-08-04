---
name: opencode-browser-adapter
description: Use OpenCode Browser v0.2 with connector-first routing, compact action chains, conditional settling, and fail-soft search.
---

# OpenCode Browser Adapter v0.2 for Codex

Prefer a native app connector or API for structured operations in Airtable, Stripe, Gmail, Calendar, and similar services. Use the browser for UI-only features, connector gaps, and visual verification. Do not use a raw Node/browser integration when the four `browser_*` tools are available.

Pass a user-named profile on the first useful call. Avoid status-only calls. Combine find, action, `settle`, and `postObserve` in one `browser_run`; never synthesize fixed-delay steps. Use one `value` field for text and prefer verified `replaceText` for editors.

Use lexical or auto search normally. Reserve `searchStrategy: "deep"` for multilingual, code-heavy, or genuinely semantic matching. When an explicit deep call may take over ten seconds, set a longer initial wrapper yield instead of issuing repeated `wait` tool calls.

On `approval_required`, review the chain and call `browser_run` again with only `approvalToken`. Reuse `sessionId`, and call `browser_finalize` when the work is complete.
