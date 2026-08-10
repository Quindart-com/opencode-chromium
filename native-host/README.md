# Native host

The native host bridges Chromium native messaging to the provider-neutral browser runtime over local IPC. It keeps semantic and visual inference outside the extension service worker.

Run locally with:

```powershell
bun native-host/src/host.js
```

Each connected profile has its own local IPC endpoint and live registry entry. New settings use `AGENT_BROWSER_*`; `OPENCODE_BROWSER_*` remains a lower-priority compatibility alias. Snowflake-default retrieval, explicit lexical/auto alternatives, and Qwen deep retrieval cache under `AGENT_BROWSER_SEMANTIC_DIR`. Optional visual detection caches under `AGENT_BROWSER_VISUAL_DIR`.

The setup command writes browser-specific native messaging manifests:

```powershell
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
```
