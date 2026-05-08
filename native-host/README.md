# Native Host

The native host bridges Chromium native messaging to OpenCode-local IPC.

It replaces Codex's compiled `extension-host.exe` with a readable implementation that we can maintain and extend.

## Entry Point

```bash
node native-host/src/host.js
```

## Local IPC

The host listens on:

- Windows: `\\.\pipe\opencode-browser`
- macOS/Linux: `<tmp>/opencode-browser.sock`

Override with `OPENCODE_BROWSER_IPC_PATH`.

Both Chromium native messaging and local IPC use 4-byte length-prefixed JSON frames.
