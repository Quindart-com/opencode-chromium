# Native Host

The native host bridges Chromium native messaging to OpenCode-local IPC.

It replaces Codex's compiled `extension-host.exe` with a readable implementation that we can maintain and extend.

## Entry Point

```bash
node native-host/src/host.js
```

## Local IPC

Each connected browser profile listens on its own generated local IPC endpoint:

- Windows: `\\.\pipe\opencode-browser-<instance>`
- macOS/Linux: `<tmp>/opencode-browser-<instance>.sock`

The endpoint is advertised through the local live-profile registry so OpenCode can route to the selected open profile. Override a specific instance endpoint with `OPENCODE_BROWSER_INSTANCE_IPC_PATH`.

Both Chromium native messaging and local IPC use 4-byte length-prefixed JSON frames.

## Semantic Model Cache

Optional page-search retrieval runs through a native-host worker thread with local ONNX inference so browser relay requests stay responsive while Qwen inference is running. The current stack uses Qwen3 embeddings for broad retrieval and Qwen3 reranking for the final relevant context. Model files are downloaded on first prepare/use and cached under:

- Windows: `%LOCALAPPDATA%\OpenCodeBrowser\semantic\models`
- macOS/Linux: `~/.cache/opencode-browser/semantic/models` unless `XDG_CACHE_HOME` is set

Override the semantic settings/cache root with `OPENCODE_BROWSER_SEMANTIC_DIR`.

The extension popup can delete the cached retrieval model files. Deleting them only removes local cache files; enabling or preparing retrieval later downloads them again.

## Visual Model Cache

`browser_visual_map` is DOM-first and does not load a model during normal use. When visual detection is enabled or forced, the native host can run a local Transformers.js screenshot detector and cache its files under:

- Windows: `%LOCALAPPDATA%\OpenCodeBrowser\visual\models`
- macOS/Linux: `~/.cache/opencode-browser/visual/models` unless `XDG_CACHE_HOME` is set

Override the visual settings/cache root with `OPENCODE_BROWSER_VISUAL_DIR`. Visual detector results are normalized to lean UI boxes before returning to the agent; scores and model diagnostics stay behind `detail: "debug"`.

## Native Messaging Registration

Use the root setup script to install the browser manifest for the extension ID generated when loading `extension/` as unpacked:

```bash
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
```

On Windows the script writes a wrapper under `%LOCALAPPDATA%\OpenCode\browser` and registers the manifest path in `HKCU`. On macOS it writes the manifest under the selected browser's `NativeMessagingHosts` directory.
