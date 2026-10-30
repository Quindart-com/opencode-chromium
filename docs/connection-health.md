# Connection health and local development builds

The extension shows installed Codex, OpenCode, DeepSeek Harness, Claude Code and Claude Desktop clients as separate rows with colored connection badges. It also shows a live recognized client if the executable is outside the host's search path. Old configuration files alone do not mark a harness as installed. The local CLI bridge has its own status. A bridge response does not prove that a particular chat has received its MCP tools.

Connected means the host has observed a live initialized browser client for that harness. Rows aggregate its links. MCP clients announce after initialization and OpenCode after registering tools, then heartbeat every 15 seconds. Missing heartbeats become stale after 45 seconds; closed links disappear. An older runtime without installation information prompts for an update instead of listing guessed harnesses. Generic Claude clients that do not identify Code versus Desktop remain unidentified, rather than marking the wrong application connected. Identity hints are sanitized self-reports, not authentication. Inventory contains no page contents, credentials, commands or arbitrary client names.

## Direct recovery

**Connect / Reconnect** runs a tracked background CLI action. It refreshes this plugin's browser links and tool catalog inside a running harness. Codex and DeepSeek receive the standard MCP tool-list notification; OpenCode uses its native tool-registry reload. The process-wide guard protects active browser calls and approvals, including other contexts sharing an OpenCode process. Retained sessions and tabs stay available. Harness applications and unrelated MCP servers remain running.

If no live plugin controller exists, the helper repairs this plugin's configuration and uses supported CLI/configuration reload paths. It reports waiting for the harness, and the row stays disconnected until a real heartbeat arrives. A successful installer or reload command alone never marks a row connected. A harness may apply a refreshed catalog on its next turn. When Claude has no live plugin controller, configuration is repaired and the status remains waiting until Claude adopts it; the helper does not close or restart the application. A failed Codex chat may have no controller to notify: its desktop connection requires **Plugins → OpenCode Browser Plugin → Manage → disable → enable**, followed by invoking the skill again in the same chat. The helper returns `plugin_reload_required` for this case instead of reinstalling metadata or reporting a successful reconnect.

The panel polls automatically, without a duplicate refresh button or a second healthy bridge badge in the header. **Connection help** contains **Run checks**, which runs local diagnostics and safe dead-participant cleanup, and **Reconnect local bridge**, which reconnects native messaging only when the extension has no owned work. Neither action asks users to copy a command. Harness rows and their adaptive Connect / Reconnect controls remain visible without expanding the help section.

## Codex startup and release recovery

The native plugin starts Node and imports the installed local runtime launcher. It does not download npm packages during the MCP handshake. A missing runtime returns `MCP_RUNTIME_SETUP_REQUIRED` with setup and scoped reload guidance. The catalog still identifies the plugin release; the selected runtime and staged updates retain their existing activation rules.

The 1.10.1 release refreshed catalogs only after managed MCP startup or explicit setup. That could not fix an older launcher that timed out before starting, or an enabled plugin whose Git marketplace source was missing. Native-host startup now schedules catalog repair independently, and the helper checks the installed manifest and launcher instead of treating a successful upgrade command as proof. It coalesces concurrent hosts, backs off failures, checks same-version catalogs every six hours and preserves explicit local or pinned sources. It does not restart Codex or silently add a duplicate global MCP server.

Skill dependency metadata is validated as a scalar command or omitted. A command array rejected by Codex can no longer pass the metadata regression check. A successful fresh-process discovery remains separate from verification in an affected chat. `diagnose-mcp --tools-unavailable` returns `MCP_CHAT_RELOAD_REQUIRED` after a healthy startup and includes the verified reload steps without suggesting an app restart.

The same scoped repair is available to agents and operators:

    opencode-chromium harness reconnect codex
    opencode-chromium harness reconnect opencode
    opencode-chromium harness reconnect dsh
    opencode-chromium harness reconnect claude-code
    opencode-chromium harness reconnect claude-desktop

Controls are restricted to trusted extension pages. Embedded pages, website content scripts and browser-agent IPC callers cannot start local CLI actions. Helpers accept only fixed action kinds and validated harness IDs, use a fixed CLI entry, run hidden on Windows and report bounded status codes. Private control endpoints require an unpredictable token; their paths and tokens never enter the popup.

## Updates

**Update CLI** and **Check and install updates** start a detached helper so the update survives native-host reconnection. The helper resolves a stable release of the official npm package, validates the side-by-side runtime, updates the global CLI and refreshes owned installed guidance. Automatic-update preferences are preserved. Active work defers activation rather than being interrupted. Progress, completion and deferred activation are visible in the extension; the command-copy update prompt is removed.

## Decision usage

The dashboard defaults to the active service and the last seven UTC days. Select another service, all services, the last 30 days, previous calendar week, previous calendar year or all history. It shows separate input/output tokens, attempts, reported cost, response time, a token chart and a comparison table.

New records capture provider and service before dispatch, including failed calls and setup tests before a provider switch. Older records are attributed only when their model identifies the service; ambiguous records remain in an explicit unassigned group. Missing token/cost reports are excluded from those totals and disclosed. No estimates are presented as provider charges. History is folded incrementally from the complete local ledger, without the previous 2 MB cutoff. Long charts combine date ranges to keep native messages bounded while preserving totals. Local request-saving counters are explicitly labeled as session-wide, separate from service usage.

## Configuration and catalogs

Harness definitions, labels and icons share one catalog across setup, connection reporting and the extension. Automatic setup selects actual installations; an explicit target/configuration can still be repaired. `OPENCODE_BROWSER_<HARNESS>_EXECUTABLE` and `_CONFIG` override discovery (`CLAUDE_CODE` / `CLAUDE_DESKTOP` use underscores). Standard `CODEX_HOME`, `DSH_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` paths remain respected. Supported browsers accept `OPENCODE_BROWSER_<BROWSER>_EXECUTABLE` and `_USER_DATA_DIR`; non-Windows installations also accept `_NATIVE_MESSAGING_DIR`. Overrides select an explicit path without guessing another installation when that path is invalid.

Decision service URLs remain fixed credential destinations. Advanced settings can select a service-compatible text or image model; blank fields retain the suggested catalog model. The CLI equivalents are `providers configure --model MODEL --image-model MODEL`. Image sharing still requires its separate opt-in, and changing service preserves other saved service keys. Legacy usage with unfamiliar model names remains unassigned.

`OPENCODE_BROWSER_MODEL_CATALOG` optionally points to a local JSON file with `semantic` and `visual` arrays. It is limited to 256 KiB, 32 semantic models and 16 visual models. Entries use the existing model fields and supported adapters; repository IDs must have `owner/model` form. Semantic dimensions must match the embedding, and deep models require a reranker. Custom IDs add choices without replacing built-in adapters. Invalid catalogs fall back to built-ins with a reported status; changing a catalog does not download or activate a model. Model selection and download remain explicit. Release lookup and installation use npm's own registry, proxy and authentication configuration without logging credentials.

## Human authorization

When automatic approval review rejects an action or authorization is missing, the tool/skill tells the agent to use its harness's question tool with Approve / Disapprove and keep the task pending. Approval resumes the original authorization path; changing tools or harnesses is not an alternative permission path. Upload consent distinguishes an explicit refusal from a closed, unavailable or expired confirmation. Genuine refusal waits for a new user instruction. Trusted extension upload confirmation and file/destination checks remain enforced. Approval guidance survives compact/artifact tool output.

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

The refresh paths follow the [MCP tool-list change contract](https://modelcontextprotocol.io/specification/latest/server/tools), [OpenCode plugin tool reload](https://opencode.ai/v2/docs/build/plugins/server/#tools) and [DeepSeek MCP client reload behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md). OpenCode tool reload reapplies registered transforms; it does not rerun plugin setup.
