# OpenCode Chromium Browser Plugin

OpenCode browser automation for Chromium-based browsers, built from readable source instead of a closed browser bundle.

This project provides:

- A Manifest V3 Chromium extension for browser access.
- A Node.js native messaging host for the local browser bridge.
- An OpenCode plugin and skill that expose browser tools to agents.

## Why

Codex ships a Chrome browser integration that is closed source and tied to Chrome. That is not a great fit if you want browser automation that you can inspect, modify, and use across Chromium-family browsers.

Also, if my browser starts quietly pulling down a full AI model in the background, that browser is not working for me anymore. I want a browser stack that stays lean, transparent, and under user control.

This repository rebuilds the integration around Chromium APIs, native messaging, and OpenCode-native tools.

## Supported Browsers

Known targets:

- Google Chrome
- Microsoft Edge
- Brave
- Chromium
- Other Chromium-based browsers that support `chrome.debugger` and native messaging

Firefox is not supported in this version because it does not expose the same Chrome DevTools Protocol and extension API surface.

## Requirements

- Node.js 20 or newer
- npm
- OpenCode
- A supported Chromium-based browser

## Setup On Windows

Install dependencies:

```powershell
npm install
```

Load the extension:

1. Open your browser's extensions page, for example `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select this repository's `extension/` folder.
5. Copy the generated extension ID.

Install the native messaging host for that extension ID:

```powershell
npm run install:native-host -- --extension-id <extension-id> --browsers chrome
```

To install for every supported Chromium browser that can be auto-detected:

```powershell
npm run install:native-host -- --auto --browsers all
```

Restart OpenCode from this repository so it loads `.opencode/plugins/chromium-browser.js` and `.opencode/skills/chromium-browser/SKILL.md`.

## Setup On macOS

Install dependencies:

```bash
npm install
```

Load the extension:

1. Open your browser's extensions page, for example `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select this repository's `extension/` folder.
5. Copy the generated extension ID.

Install the native messaging host for that extension ID:

```bash
npm run install:native-host -- --extension-id <extension-id> --browsers chrome
```

To install for every supported Chromium browser that can be auto-detected:

```bash
npm run install:native-host -- --auto --browsers all
```

Restart OpenCode from this repository so it loads `.opencode/plugins/chromium-browser.js` and `.opencode/skills/chromium-browser/SKILL.md`.

## Diagnostics

Check the plugin and tests:

```bash
npm run check
```

List detected browsers:

```bash
npm run list:browsers
```

Check native host registration:

```bash
npm run check:native-host -- --json
```

Check whether the extension is installed in a browser profile:

```bash
npm run check:extension -- --browser chrome --extension-id <extension-id>
```

OpenCode browser tools should start with `browser_status`. If the native host is reachable and the extension is connected, browser automation is ready.

## Troubleshooting

- If `browser_status` cannot reach the host, reload the unpacked extension and reinstall the native host manifest with the current extension ID.
- If the extension was loaded in a different browser profile, pass the right browser to the check scripts with `--browser chrome`, `--browser edge`, `--browser brave`, or `--browser chromium`.
- If file uploads are blocked, open the extension details page and enable access to file URLs.
- If the browser was already running while you changed native messaging manifests, restart the browser before retrying.

## How It Works

```text
OpenCode tools
  -> local IPC
  -> native-host/
  -> Chromium native messaging
  -> extension/
  -> chrome.debugger and Chromium APIs
  -> browser tab
```

The native host is intentionally small and readable. The extension owns browser access, tab tracking, CDP execution, screenshots, downloads, cursor overlays, console logs, and network events.

## Repository Layout

```text
extension/         Chromium extension source
native-host/       Native messaging host and IPC bridge
opencode-plugin/   OpenCode plugin source
.opencode/         Local OpenCode plugin entrypoint and browser skill
scripts/           Setup and diagnostic helpers
docs/              Architecture notes
```

## Security Notes

This project gives OpenCode powerful browser automation capabilities. Read the source before installing it, and only load the extension from a checkout you trust.

The native host communicates locally through Chromium native messaging and a local IPC socket/pipe. The extension requests broad browser permissions because browser automation needs access to tabs, downloads, debugging, scripting, and page inspection.

## Development

Run tests:

```bash
npm test
```

Validate the OpenCode plugin shape:

```bash
npm run check:opencode-plugin
```

Start the native host directly for local debugging:

```bash
npm run host
```

## License

MIT
