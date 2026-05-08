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
- `browser_list_tabs`
- `browser_new_tab`
- `browser_claim_tab`
- `browser_navigate`
- `browser_screenshot`
- `browser_click`
- `browser_type`
- `browser_keypress`
- `browser_snapshot`
- `browser_finalize`

## First Step

Before browser work, call `browser_status`.

If the native host is not reachable, tell the user to load the extension and install the native messaging manifest before retrying.

## Tab Use

- Use `browser_list_tabs` with `scope: "user"` to find existing tabs.
- Use `browser_claim_tab` when the user wants to control an already-open tab.
- Use `browser_new_tab` or `browser_navigate` without `tabId` for a new controlled tab.
- Use `browser_finalize` before ending browser work. Keep tabs only when the user needs the live page after the turn.

## Interaction Safety

Confirm before actions that submit forms, send messages, upload files, make purchases, change permissions, delete data, save passwords/payment details, or transmit sensitive personal data.

Do not solve CAPTCHAs, bypass paywalls, bypass browser safety interstitials, or complete final password-change submissions.

## Current Limitations

- Initial browser target is Chrome and Chromium-based browsers.
- Firefox is not supported in this version.
- Locator-style interactions are not implemented yet; use snapshots and coordinate clicks for the MVP.
- Screenshots return base64 PNG data from the tool.
