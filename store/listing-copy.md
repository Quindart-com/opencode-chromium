# Chrome Web Store listing copy for opencode-chromium

## Basic info

- **Name:** opencode-chromium
- **Summary (132 chars max):**
  Browser automation for AI coding agents via OpenCode, Codex, and MCP: tabs, input, and DOM control through a local native messaging bridge.
- **Category:** Developer Tools
- **Language:** English (United States)
- **Privacy policy URL:** https://quindart-com.github.io/opencode-chromium/PRIVACY.html
- **Homepage URL:** https://github.com/Quindart-com/opencode-chromium

## Detailed description

opencode-chromium is the browser side of local, agent-driven browser automation. It pairs with any AI coding tool — OpenCode, Codex, Codex-compatible CLIs, or any MCP client — through a native messaging host installed on your own computer.

What it provides:

- **Real browser, real pages.** Agents can open, claim, list, navigate, reload, and close tabs in your existing browser profile, without touching new windows you did not ask for.
- **True input automation.** Coordinate-based mouse, keyboard, scroll, drag, and screenshot flows work across normal web apps — not just static HTML — because it drives the browser's own DevTools protocol on tabs you control.
- **Readable context.** Lean DOM snapshots, visible-UI maps, and page search keep the agent's context small while it works.
- **Foundational utilities.** History and download lifecycle events, clipboard access, and per-profile session management for serious agent workflows.
- **Fast, local, and private.** Everything runs on your device. The optional semantic page-search model is downloaded once and cached locally; nothing is transmitted to any cloud.

How it works:

1. Install the extension and the native host bundled with the package (the installer script in the npm package wires them up for you).
2. Connect an agent session (see https://github.com/Quindart-com/opencode-chromium#readme for OpenCode, Codex, and MCP quick starts).
3. The agent asks for browser access, and you keep full control: tabs are created in the background, per-session tab groups stay organized, and sessions finalize cleanly.

## Permission justification (for the review)

This extension is a general-purpose automation bridge, so it asks for the browser permissions it needs to serve any of its documented features:

- **tabs, tabGroups, history, storage:** manage the tabs and browser state an agent session explicitly works with, search browsing history when requested, and remember your per-profile label locally.
- **scripting, <all_urls>, debugger:** inspect pages, run coordinate input, and capture page state. Pages are only touched when a tool call from a session you started asks for it; the extension never acts on its own.
- **downloads:** report download lifecycle events to the agent so it can wait for and locate files it triggered.
- **nativeMessaging:** the sole channel to the locally installed host executable. No remote servers are involved.
- **alarms:** keeps the service worker alive so automation sessions stay responsive while open.

All data stays on your device. See the privacy policy (link above) for details.

## Single listing screenshot

- provider `store/opencode-chromium-1280x800.png`
- (optional promo tile `store/opencode-chromium-440x280.png`)

## Review notes

- Manifest V3, no remote code, no `eval`, CSP-locked (`script-src 'self'`).
- The security-sensitive scan (web store safety check) runs in CI on every release: https://github.com/Quindart-com/opencode-chromium/blob/master/.github/workflows/webstore.yml
