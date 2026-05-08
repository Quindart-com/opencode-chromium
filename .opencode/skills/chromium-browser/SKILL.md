---
name: chromium-browser
description: Control Chrome and Chromium-based browsers through the OpenCode Browser extension and native host.
---

# Chromium Browser

Use this skill when the user asks OpenCode to inspect, navigate, automate, test, screenshot, or interact with Chrome or a Chromium-based browser.

## Runtime Model

This integration does not use Codex's Node REPL or `browser-client.mjs` runtime.

Use OpenCode browser tools directly:

- `browser_status`
- `browser_capabilities`
- `browser_list_tabs`
- `browser_selected_tab`
- `browser_get_tab`
- `browser_new_tab`
- `browser_claim_tab`
- `browser_name_session`
- `browser_navigate`
- `browser_reload`
- `browser_back`
- `browser_forward`
- `browser_close_tab`
- `browser_history`
- `browser_screenshot`
- `browser_move`
- `browser_click`
- `browser_double_click`
- `browser_scroll`
- `browser_drag`
- `browser_type`
- `browser_keypress`
- `browser_snapshot`
- `browser_dom_snapshot`
- `browser_dom_click`
- `browser_dom_type`
- `browser_locator_count`
- `browser_locator_click`
- `browser_locator_fill`
- `browser_locator_text`
- `browser_set_file_input`
- `browser_clipboard_read_text`
- `browser_clipboard_write_text`
- `browser_enable_inspection`
- `browser_console_logs`
- `browser_network_events`
- `browser_clear_events`
- `browser_download_events`
- `browser_clear_download_events`
- `browser_cdp`
- `browser_turn_end`
- `browser_finalize`

## First Step

Before browser work, call `browser_status`.

If the native host is not reachable, tell the user to load the extension and install the native messaging manifest before retrying.

For setup diagnostics, use the repository scripts:

- `node scripts/installed-browsers.js --json`
- `node scripts/chrome-is-running.js --browser chrome --check --json`
- `node scripts/check-extension-installed.js --browser chrome --json`
- `node scripts/check-native-host.js chrome --json`
- `node scripts/open-browser-window.js --browser chrome --dry-run --json`

Only run `scripts/open-browser-window.js` without `--dry-run` after the user agrees to open a browser window.

## Tab Use

- Use `browser_list_tabs` with `scope: "user"` to find existing tabs.
- Use `browser_claim_tab` when the user wants to control an already-open tab.
- Claim only tabs returned by `browser_list_tabs` with `scope: "user"`; do not guess tab IDs.
- Use `browser_new_tab` or `browser_navigate` without `tabId` for a new controlled tab.
- Session tabs are grouped in the browser by the extension.
- The extension tracks whether a tab was agent-created or user-claimed. `browser_finalize` closes unkept agent-created tabs and releases unkept user-claimed tabs without closing them.
- Use `browser_finalize` before ending browser work. Keep tabs only when the user needs the live page after the turn.
- Use `status: "deliverable"` for tabs that are final user-facing outputs.

## Reliable Input

- Browser tools target the controlled tab through the extension and CDP without bringing that tab or window to the foreground by default.
- Use `browser_move` when you need to show the OpenCode cursor overlay before acting on the current tab.
- `browser_click`, `browser_double_click`, and `browser_drag` serialize mouse gestures per tab so concurrent agents do not interleave press/move/release events.
- If a click misses, take a fresh screenshot or snapshot before choosing new coordinates.
- Prefer `browser_dom_snapshot` plus `browser_dom_click` for visible interactable elements when it avoids brittle coordinates.
- Use `browser_locator_*` for straightforward CSS-selector interactions; take a fresh DOM snapshot before retrying failed selectors.

## Inspection

- Use `browser_enable_inspection` before collecting console or network events.
- Use `browser_console_logs` for `Runtime.consoleAPICalled` and `Log.entryAdded` events.
- Use `browser_network_events` for captured `Network.*` events.
- Use `browser_cdp` for targeted CDP commands such as `Runtime.evaluate`, `DOM.getDocument`, or `Performance.getMetrics`; the plugin enables the Performance domain automatically for metrics.
- Use `browser_download_events` after actions that may start downloads. Inline PDFs are reported with `status: "opened_inline"` when Chrome opens them in the browser instead of downloading them.
- Use `browser_set_file_input` for file inputs after confirming uploads with the user when required.
- Confirm before reading or writing clipboard content unless the user explicitly requested clipboard use.

## Interaction Safety

Confirm before actions that submit forms, send messages, upload files, make purchases, change permissions, delete data, save passwords/payment details, or transmit sensitive personal data.

Do not solve CAPTCHAs, bypass paywalls, bypass browser safety interstitials, or complete final password-change submissions.

## Current Limitations

- Initial browser target is Chrome and Chromium-based browsers.
- Firefox is not supported in this version.
- Locator-style interactions are CSS-selector based, not full Playwright parity.
- Screenshots return base64 PNG data from the tool.
