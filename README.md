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
