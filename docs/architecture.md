# Architecture

## Components

### Provider-neutral browser core

`browser-core/` is the public AI contract. It owns typed action chains, session state, profile selection by ID or label, preflight approval binding, output budgets, artifact lifetime, and schema conversion. MCP, OpenCode, and direct SDK integrations all call this same runtime.

The default surface is `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. It is deliberately small enough to remain in an agent's tool context continuously.

### Client adapters

- `codex-adapter/mcp-server.js` uses the official MCP SDK over stdio or Streamable HTTP.
- `opencode-plugin/src/ai-plugin.js` translates the same registry into OpenCode's plugin shape.
- `browser-core/sdk.js` exports OpenAI, Anthropic, Gemini, and MCP tool schemas plus a common dispatcher.
- `opencode-plugin/src/plugin.js` retains the original granular operations as the implementation layer and explicit legacy surface.

### Legacy OpenCode tools

The compatible legacy mode exposes the original granular browser operations. It is not the default AI surface because advertising all tools consumes unnecessary context.

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
- `browser_page_search`
- `browser_visual_map`
- `browser_page_inspect`
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
- Run lexical-first adaptive Snowflake retrieval, explicit-deep Qwen retrieval, and optional visual detection outside the extension service worker.
- Keep one multiplexed local IPC connection per live profile so a chain avoids connection setup on every action.

Messages use JSON-RPC 2.0. Browser-native messaging frames are 4-byte length-prefixed JSON payloads.

### Chromium Extension

The extension owns browser access. It handles tab management, `chrome.debugger` attach/detach, CDP execution, screenshots, download observation, cursor overlay state, and browser metadata.

Tabs are tracked by profile, session, and origin. A tab can be explicitly released without closing it. Agent-created tabs can be closed during finalization. User-claimed tabs are released from the automation session during finalization unless explicitly kept, but they are not closed by default.

## AI request lifecycle

```text
model tool call
  -> validate the complete typed chain and all step references
  -> if consequential: store the immutable request and return one approval token before browser side effects
  -> resolve a connected profile and session-owned tab
  -> execute steps, conditional settles, and post-observation over persistent IPC
  -> detach debugger automatically at chain end
  -> return a bounded summary or ephemeral artifact URI
```

Automation targets controlled tabs through CDP without foregrounding the Chrome window by default. Mouse gestures are serialized per tab so a click or drag sequence cannot be interleaved by another agent, and inline PDF responses are reported as browser download events with `status: "opened_inline"` when Chrome renders them instead of creating a download item.

## Context Optimization

Large-page inspection uses a layered contract:

- `browser_page_search` extracts DOM page units, returns unique lexical matches immediately, and uses a small cached model only for uncertain auto searches. Qwen runs only for explicit deep search.
- `browser_visual_map` returns visible UI boxes as `{ node_id, kind, label, box, source }` without screenshot data. It is DOM-first and only calls the optional local screenshot detector when DOM mapping finds no elements or `vision: "force"` is passed.
- `browser_page_inspect` remains the zoom-in step for one node or selector when the agent needs ancestors, siblings, child structure, styles, or a screenshot clip box.

The optional visual detector lives in the native host. Its default model metadata points at `onnx-community/grounding-dino-tiny-ONNX`, runs through Transformers.js, and is disabled until the user enables it or a tool call explicitly forces it. Lean tool responses strip detector scores; use `detail: "debug"` when model diagnostics are needed.

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

When exactly one profile is connected, browser tools can use it automatically. With multiple profiles, pass the exact user-named profile on the first useful v0.2 call; `browser_session` open returns tabs immediately. If a selected profile closes, requests fail instead of silently falling back or launching a browser.

## Public Source Boundary

The public repository contains the readable OpenCode plugin, Chromium extension, native host, setup helpers, and documentation. Internal comparison material is not part of the published source tree.
