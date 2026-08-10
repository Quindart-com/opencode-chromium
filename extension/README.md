# Browser extension

Readable Manifest V3 Chromium extension for `opencode-browser-plugin`. It owns tabs, CDP execution, screenshots, downloads, cursor overlays, and captured console/network events. Snowflake, Qwen, and visual model inference stay in the native host.

Load `extension/` as an unpacked extension, then install the native host for the generated extension ID with `bun run install:native-host`.
