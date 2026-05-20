# Architecture

## Components

### OpenCode Plugin

The OpenCode plugin exposes browser automation as custom tools using `@opencode-ai/plugin`.

Tool set:

- `browser_status`
- `browser_capabilities`
- `browser_list_profiles`
- `browser_selected_profile`
- `browser_select_profile`
- `browser_name_profile`
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

### Native Host

The native host has three jobs:

- Speak Chromium native messaging over stdin/stdout with the extension.
- Expose a per-profile local IPC endpoint that OpenCode tools can call.
- Register the currently connected browser profile in a local live-profile registry.

Messages use JSON-RPC 2.0. Browser-native messaging frames are 4-byte length-prefixed JSON payloads.

### Chromium Extension

The extension owns browser access. It handles tab management, `chrome.debugger` attach/detach, CDP execution, screenshots, download observation, cursor overlay state, and browser metadata.

Tabs are tracked by profile, session, and origin. Agent-created tabs can be closed during finalization. User-claimed tabs are released from the automation session during finalization unless explicitly kept, but they are not closed by default.

Automation targets controlled tabs through CDP without foregrounding the Chrome window by default. Mouse gestures are serialized per tab so a click or drag sequence cannot be interleaved by another agent, and inline PDF responses are reported as browser download events with `status: "opened_inline"` when Chrome renders them instead of creating a download item.

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

The plugin first resolves the requested live profile, then sends the request to that profile's IPC endpoint. The host relays compatible requests to its extension and returns the response to the OpenCode tool.

## Browser Profiles

Each extension profile stores a generated profile ID in extension-local storage. Users can add a local label such as `work` or `personal` from the extension popup or the `browser_name_profile` tool. Labels are not baked into source code or setup files.

When exactly one profile is connected, browser tools can use it automatically. When multiple profiles are connected, OpenCode must call `browser_select_profile` before profile-scoped actions. If a selected profile closes, requests for that profile fail instead of falling back to another open profile or launching a browser.

## Public Source Boundary

The public repository contains the readable OpenCode plugin, Chromium extension, native host, setup helpers, and documentation. Internal comparison material is not part of the published source tree.
