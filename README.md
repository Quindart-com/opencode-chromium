# OpenCode Chromium Browser Plugin

This repository rebuilds the Codex Chrome browser integration for OpenCode.

The goal is to provide browser automation for Chrome and Chromium-based browsers through an OpenCode-native plugin, a Chromium extension, and a native messaging host that we control.

## Layout

```text
extension/         Chromium extension source for browser-side control
native-host/       Native messaging host and local IPC bridge
opencode-plugin/   OpenCode plugin, tools, and skill files
scripts/           Install, check, and development helper scripts
docs/              Architecture and implementation notes
reference/         Extracted Codex artifacts for protocol reference only
```

## Target Architecture

```text
OpenCode custom tools
  -> local IPC
  -> native-host
  -> Chromium native messaging
  -> extension background service worker
  -> chrome.debugger / Chrome APIs
  -> browser tab
```

The implementation is intentionally independent of Codex's `browser-client.mjs` and `extension-host.exe`. The reference files remain available to compare protocol behavior, but the OpenCode integration should be readable, maintainable, and browser-family aware.

## Initial Browser Scope

- Google Chrome
- Microsoft Edge
- Brave
- Chromium-compatible browsers that support `chrome.debugger` and native messaging

Firefox is out of scope for the first version because it does not expose the same CDP/debugger surface.

## Development Quick Start

1. Load `extension/` as an unpacked extension in Chrome.
2. Copy the unpacked extension ID from `chrome://extensions`.
3. Install the native messaging manifest. If the extension is already loaded, use auto-detection:

```bash
node scripts/install-native-host.js --auto --browsers all
```

Or install manually with an explicit extension ID:

```bash
node scripts/install-native-host.js --extension-id <extension-id> --browsers chrome
```

4. Install root development dependencies with `npm install` if they are not already present.
5. Start OpenCode in this repo. The local plugin at `.opencode/plugins/chromium-browser.js` exposes the browser tools. OpenCode manages the small `.opencode/package.json` dependency set for local plugin loading.

If OpenCode was already running, restart it after installing dependencies or changing plugin files.

## Diagnostics

```bash
node scripts/installed-browsers.js --json
node scripts/chrome-is-running.js --browser chrome --check --json
node scripts/check-extension-installed.js --browser chrome --extension-id <extension-id> --json
node scripts/check-native-host.js chrome --extension-id <extension-id> --json
node scripts/open-browser-window.js --browser chrome --dry-run --json
```
