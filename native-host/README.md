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

## Native Messaging Registration

Use the root setup script to install the browser manifest for the extension ID generated when loading `extension/` as unpacked:

```bash
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
```

On Windows the script writes a wrapper under `%LOCALAPPDATA%\OpenCode\browser` and registers the manifest path in `HKCU`. On macOS it writes the manifest under the selected browser's `NativeMessagingHosts` directory.
