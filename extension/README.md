# Extension

Readable Chromium extension source for OpenCode browser automation.

The extension targets Manifest V3 and the `chrome.*` extension API surface used by Chrome and Chromium-based browsers.

The popup controls profile labeling and optional semantic page-search settings. Qwen3 embedding/reranker models and optional visual detectors do not run in the extension; model inference stays in the native host, which caches model files on disk.

## Load Unpacked

Open your browser's extensions page, enable developer mode, and load this `extension/` directory as an unpacked extension.

The extension expects a native messaging host named `com.opencode.browser`.
