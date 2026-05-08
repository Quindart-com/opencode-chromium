# Extension

Readable Chromium extension source will live here.

The first implementation targets Manifest V3 and the `chrome.*` extension API surface used by Chrome and Chromium-based browsers.

## Load Unpacked

Open `chrome://extensions`, enable developer mode, and load this `extension/` directory as an unpacked extension.

The extension expects a native messaging host named `com.opencode.browser`.
