<p align="center">
  <img src="assets/logo.svg" alt="OpenCode Chromium Browser Plugin Logo" width="200"/>
</p>

<h1 align="center">Chromium Agent Browser</h1>

<p align="center">
  <strong>AI-first browser automation for Codex, OpenCode, MCP clients, and direct model SDKs—built from readable source.</strong>
</p>

<p align="center">
  <a href="https://x.com/ABadissy/status/2052852726736789586"><strong>Watch the demo on X</strong></a>
</p>

<p align="center">
  <a href="#why">Why</a> •
  <a href="#features">Features</a> •
  <a href="#supported-browsers">Browsers</a> •
  <a href="#requirements">Requirements</a> •
  <a href="#setup-on-windows">Windows Setup</a> •
  <a href="#setup-on-macos">macOS Setup</a> •
  <a href="#diagnostics">Diagnostics</a> •
  <a href="#troubleshooting">Troubleshooting</a> •
  <a href="#how-it-works">Architecture</a> •
  <a href="#security-notes">Security</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>

---

## Why

Codex ships a Chrome browser integration that is **closed source** and tied to Chrome. That is not a great fit if you want browser automation that you can inspect, modify, and use across Chromium-family browsers.

> Also, if my browser starts quietly pulling down a full AI model in the background, that browser is not working for me anymore. I want a browser stack that stays lean, transparent, and under user control.

This repository rebuilds the integration around Chromium APIs, native messaging, a provider-neutral runtime, and **four compact AI tools**. No proprietary blobs and no client lock-in.

---

## Features

- **Manifest V3 Chromium extension** — Tab management, CDP execution, screenshots, downloads, cursor overlays, console/network logs.
- **Readable Node.js native messaging host** — Bridges the browser extension to OpenCode via local IPC.
- **Lexical-first adaptive search** — Exact matches return immediately; uncertain English matches can use a 22.6M-parameter Snowflake model, while the retained Qwen bundle is reserved for explicit deep retrieval.
- **Visual UI map** — DOM-first visible control and container boxes for agents that need coordinates without paying for full screenshots. An optional local screenshot detector can be enabled in the native host for fallback cases.
- **AI-first action chains** — Up to 20 typed actions in one request, with step references and automatic turn cleanup.
- **Minimal model context** — Four default tools, lean observations, response budgets, and resource-backed screenshots/large results.
- **Universal clients** — Official MCP stdio and Streamable HTTP transports plus OpenAI, Anthropic, Gemini, and MCP schema exports for direct SDK use.
- **Safe chain approval** — Consequential chains pause before side effects; a token-only follow-up executes the immutable server-stored request.
- **Compatible migration** — The original 49 granular tools remain available through explicit legacy mode.
- **Multi-browser** — Works with Chrome, Edge, Brave, Chromium, and other Chromium-based browsers.
- **Multi-profile routing** — Select among currently open browser profiles, label them locally, and avoid launching or falling back to closed profiles.

---

## What's New In v0.2.0

- **Four-tool agent surface** — `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize` replace the default 49-tool context with typed chains, conditional settling, compact observations, approvals, and artifact resources.
- **Universal clients** — Codex/MCP stdio and Streamable HTTP, OpenCode, and direct OpenAI, Anthropic, Gemini, and MCP schema adapters now share one runtime.
- **Adaptive retrieval** — Lexical search stays the fast default; uncertain English matches can use the small local Snowflake model, while explicit deep search retains the Qwen retrieval path.
- **Visual mapping** — DOM-first visible controls and containers provide coordinates without returning screenshot payloads; an optional local detector is available as a fallback.
- **Compatibility and migration** — The original tools remain available through explicit legacy mode. See [the v0.2 migration guide](docs/migration-v0.2.md) for the API mapping.

---

## Supported Browsers

| Browser   | Support |
|-----------|---------|
| Google Chrome | ✅ Full |
| Microsoft Edge | ✅ Full |
| Brave | ✅ Full |
| Chromium | ✅ Full |
| Other Chromium browsers | ✅ (if `chrome.debugger` + native messaging) |
| **Firefox** | ⏳ Coming (blocked on CDP support) |

---

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- npm (bundled with Node.js); Bun remains optional
- An MCP client, OpenCode, or a JavaScript agent application
- A Chromium-based browser (Chrome, Edge, Brave, etc.)

## Connect an AI client

For Codex or another MCP client, run `node codex-adapter/mcp-server.js` as an MCP stdio server (registered as `opencode-browser-adapter`). For OpenCode, the repository-local plugin loads automatically inside this project; run `npm run install:opencode` once to register the same four-tool surface globally. For custom JavaScript agents, import `createBrowserAgent` and request `openai`, `anthropic`, `gemini`, or `mcp` tool definitions.

See [universal client integration](docs/universal-clients.md), [Codex/MCP setup](codex-adapter/README.md), and the [legacy migration table](docs/migration-v0.2.md).

---

## Setup On Windows

1. **Install dependencies**

   ```powershell
   npm install
   ```

2. **Load the extension**

   - Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, etc.)
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select this repository's `extension/` folder
   - Copy the generated extension ID

3. **Install the native messaging host**

   ```powershell
   npm run install:native-host -- --extension-id <extension-id> --browsers chrome
   ```

   Or auto-detect for all installed browsers:

   ```powershell
   npm run install:native-host -- --auto --browsers all
   ```

4. **Register the OpenCode plugin globally** (optional but recommended, makes the tools available in every project):

   ```powershell
   npm run install:opencode
   ```

5. **Restart OpenCode**. Inside this repository it picks up `.opencode/plugins/opencode-browser-adapter.js` and `.opencode/skills/opencode-browser-adapter/SKILL.md` automatically; elsewhere it uses the global registration from the previous step.

---

## Setup On macOS

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Load the extension**

   - Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, etc.)
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select this repository's `extension/` folder
   - Copy the generated extension ID

3. **Install the native messaging host**

   ```bash
   npm run install:native-host -- --extension-id <extension-id> --browsers chrome
   ```

   Or auto-detect for all installed browsers:

   ```bash
   npm run install:native-host -- --auto --browsers all
   ```

4. **Register the OpenCode plugin globally** (optional but recommended, makes the tools available in every project):

   ```bash
   npm run install:opencode
   ```

5. **Restart OpenCode**.

---

## Diagnostics

```bash
# Full check (plugin validation + tests)
npm run check

# List detected browsers
npm run list:browsers

# Check native host registration
npm run check:native-host -- --json

# Check whether the extension is installed in a browser profile
npm run check:extension -- --browser chrome --extension-id <extension-id>
```

Once set up, start with the useful browser operation. The sole connected profile is automatic; with multiple profiles, `browser_session` or the first useful call returns the compact choices without requiring an empty status round trip.

---

## Troubleshooting

- **A browser call reports no connected profile** — Reload the unpacked extension and reinstall the native host manifest with the current extension ID.
- **Extension not detected** — Make sure you're checking the right browser profile. Pass `--browser edge` or `--browser brave` as needed.
- **Multiple profiles connected** — Pass the profile ID or exact label to a core tool, or use `browser_session`. The runtime will not pick randomly or launch a closed profile.
- **File upload blocked** — Open the extension details page and enable **Allow access to file URLs**.
- **Changes not taking effect** — If the browser was already running while you changed native messaging manifests, restart it.

---

## How It Works

```text
AI client (MCP / OpenCode / direct SDK)
  -> four-tool provider-neutral browser core
  -> live profile registry
  -> per-profile local IPC (named pipe / unix socket)
  -> native-host/ (Node.js host bridge)
  -> Chromium native messaging
  -> extension/ (MV3 service worker)
  -> chrome.debugger + Chrome APIs
  -> browser tab
```

Each open browser profile runs its own extension/native-host connection and registers a live local endpoint. The plugin routes only to connected profiles, so closing a profile makes that target unavailable instead of silently using another profile. The extension owns all browser access: tab tracking, CDP execution, screenshots, downloads, cursor overlay, console logs, network events, and session management.

---

## Repository Layout

```text
extension/         Chromium extension source (MV3, background, popup, content scripts)
native-host/       Native messaging host and IPC bridge (Node.js)
opencode-plugin/   OpenCode plugin source (client + tool definitions)
browser-core/      Chaining runtime, safety, artifacts, schemas, and direct SDK
codex-adapter/     Official MCP stdio and Streamable HTTP server
.opencode/         OpenCode plugin entrypoint + browser skill
scripts/           Setup and diagnostic helpers (install, check, find)
docs/              Architecture notes
assets/logo.svg    Repository logo
```

---

## Security Notes

This project gives OpenCode **powerful browser automation capabilities**. Read the source before
installing it, and only load the extension from a checkout you trust.

- The native host communicates **locally** via Chromium native messaging and a local IPC socket/pipe.
- The extension requests broad permissions (tabs, debugger, downloads, scripting, history, etc.)
  because browser automation requires them.
- No telemetry, no analytics, and no remote AI APIs. Optional Qwen3 retrieval and visual detector models are downloaded from Hugging Face the first time you enable or force them, then reused from the local native-host cache.

---

## Development

```bash
# Run tests (native-host framing tests)
npm test

# Validate the OpenCode plugin shape
npm run check:opencode-plugin

# Start the native host directly for local debugging
npm run host
```

---

## License

MIT
