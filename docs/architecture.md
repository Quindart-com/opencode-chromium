# Architecture

## Components

### OpenCode Plugin

The OpenCode plugin will expose browser automation as custom tools using `@opencode-ai/plugin`.

Initial tool set:

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

### Native Host

The native host has two jobs:

- Speak Chromium native messaging over stdin/stdout with the extension.
- Expose a local IPC endpoint that OpenCode tools can call.

Messages use JSON-RPC 2.0. Browser-native messaging frames are 4-byte length-prefixed JSON payloads.

### Chromium Extension

The extension owns browser access. It handles tab management, `chrome.debugger` attach/detach, CDP execution, screenshots, and browser metadata.

## Protocol Shape

OpenCode tools call the host with JSON-RPC requests such as:

```json
{
  "jsonrpc": "2.0",
  "method": "executeCdp",
  "params": {
    "target": { "tabId": 123 },
    "method": "Page.navigate",
    "commandParams": { "url": "https://example.com" }
  },
  "id": 1
}
```

The host relays compatible requests to the extension and returns the response to the OpenCode tool.

## Reference Material

The `reference/` directory contains extracted Codex artifacts. These files are kept for protocol comparison and should not be edited as the source of the new implementation.
