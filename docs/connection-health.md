# Connection health and local development builds

The extension's **Bridge connected** badge means the native host has answered a request. It does not establish that an agent has started its MCP server, registered tools, or made a browser call.

The **Harness connections** panel lists the browser links observed by this host. It shows the harness, transport, runtime version, process ID, initialization or tool-call evidence, pending browser commands, and the last heartbeat. Client names are self-reported hints, not an authentication boundary. Arbitrary client names, commands, local paths, page contents and credentials are not included in this inventory.

MCP clients announce themselves after initialization; OpenCode announces after registering its tools. Loaded clients send a heartbeat every 15 seconds. A link with no heartbeat for more than 45 seconds is marked stale. Closed links disappear. Older clients remain explicitly unidentified. An installed skill alone does not create an active connection. If the host predates connection reporting, the panel says that reporting is unavailable rather than showing an empty successful inventory.

## Recovery controls

- **Refresh** requests a new inventory from the host.
- **Disconnect link** closes only the selected browser IPC socket after confirmation. It does not terminate the harness or change its configuration. A loaded harness may reconnect on its next request or heartbeat. Active browser work, pending commands and approvals prevent a disconnect.
- **Reconnect local bridge** reconnects native messaging when the extension has no owned browser work. Tabs and provider credentials stay saved. An old port's delayed disconnect event cannot overwrite the replacement connection.
- **Copy doctor command** provides `opencode-chromium doctor --repair-runtime --json` for local diagnostics.

Reconnecting a browser link cannot force a harness to reload its MCP tool list. For Codex, disable and enable the plugin in Plugins settings; a new chat may be necessary. For OpenCode, run `opencode reload`. For DeepSeek Harness, reload its MCP entry or reopen the configured profile. Verify a real browser action after reconnection.

## Refresh a stale unpacked extension

Browser reload reads the directory selected by **Load unpacked**. It does not build source files or follow a different Git worktree. If that directory still contains an old build, reloading keeps the old version.

From the source checkout you want to run:

```sh
bun src/cli/index.ts dev-extension --source /absolute/current/checkout
```

To retain an existing unpacked extension's ID, supply the exact directory shown under **Loaded from** in its browser details:

```sh
bun src/cli/index.ts dev-extension --source /absolute/current/checkout --output /absolute/existing/extension
```

The command rebuilds the current extension, checks its source fingerprint and version, publishes it to the stable unpacked path and retains the prior build as a backup. It does not change the selected production runtime or provider keys. Unrecognized nonempty output directories are rejected. Use a separate source checkout when refreshing an existing checkout's generated output.

Reload that extension in the browser after publication. Its displayed version includes `dev` and a short source fingerprint, so two builds with the same package version remain distinguishable. The saved development link is refreshed by `sync` and the Git checkout/merge hooks. Rebuild with `dev-extension` after editing source files; browser reload alone does not compile them.

New connection-reporting features require a matching runtime build. A development extension can use an older production runtime for supported browser actions, while reporting newer capabilities as unavailable. Installing an unpacked extension does not silently switch the runtime to development code.

## OpenCode V2 setup

OpenCode V2 uses the `@opencode/cli` package and loads configured plugin directories. Setup detects that package, writes one directory entry under `plugins`, and supplies the native V2 tool-transform adapter. Existing file entries for this plugin are migrated while unrelated configuration is preserved. V1 installations retain their file launcher.
