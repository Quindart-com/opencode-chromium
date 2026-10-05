# opencode-chromium

Chromium automation for Codex, Claude, OpenCode, other MCP clients, and JavaScript agents. Four tools share one browser engine: `browser_run`, `browser_observe`, `browser_session`, and `browser_finalize`. The SDK exports and 55 granular compatibility operations remain available.

## Setup

```sh
npm install -g opencode-chromium
opencode-chromium setup
```

Setup inspects known executable, application, and configuration locations. Use arrow keys to move, Space to select, and Enter to apply. Previously managed targets start selected. Each row shows the detected version and current registration. One shared runtime directory holds stable launchers; harnesses start their own client processes against it.

Install the [browser extension](https://chromewebstore.google.com/detail/opencode-chromium/hdljmmpfnhojebplbbgdgejoobmjcbml), or load the installed package's `extension/` directory unpacked. Then run `opencode-chromium link` to register native messaging. The existing `link` command also connects its legacy default clients; use explicit client commands when you need narrower registration. Automatic browser registration inside the new setup transaction is still being integrated.

```sh
opencode-chromium doctor --json
opencode-chromium status --json
```

| Harness | Connection | Platforms |
| --- | --- | --- |
| Codex CLI / Desktop | One shared MCP registration | Windows, macOS, Linux CLI |
| Claude Code | MCP | Windows, macOS, Linux |
| Claude Desktop | MCP | Windows, macOS |
| OpenCode | Native adapter by default; version-aware configuration | Windows, macOS, Linux |
| DeepSeek Harness (`dsh`) | MCP client in a Cordis profile patch | Windows, macOS, Linux |
| Other MCP clients | Standard stdio server | Client-dependent |

These are configuration targets, not a claim that every installed client version has passed live testing. OpenCode uses `plugin` for the detected 1.x contract and `plugins` for 2.x. Native and MCP browser registrations are mutually exclusive in the managed OpenCode configuration. Missing clients remain visible; unsupported platform combinations show their limitation.

## Manage registrations

```sh
opencode-chromium manage
opencode-chromium setup --targets codex,opencode --dry-run --json
opencode-chromium setup --targets claude-code --config claude-code=/absolute/config/path --json
opencode-chromium update --targets codex,opencode --json
opencode-chromium update --targets dsh --json
opencode-chromium setup --targets dsh --config dsh=/absolute/dsh/profiles/headless/cordis.patch.yml --json
opencode-chromium uninstall --targets codex --json
```

`setup`, `manage`, and `update` reconcile registrations with the installed runtime. Upgrade the npm package before `update`; it does not independently download a release. With `--json` and no targets, these commands only report discovery. Noninteractive changes require `--targets`. Configuration overrides are repeatable `--config harness-id=/path` values. Discovery respects `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`.

Use `update --production --targets codex,opencode --json` to select the installed production package explicitly and stop following a developer checkout. Without `--production`, existing branch-following preferences are preserved.

Configuration changes and selected-client skills are planned before writing, backed up, written atomically, and rolled back if a later file change fails. Dry runs leave configuration and skills untouched. JSONC edits preserve unrelated comments. Existing simple Codex TOML settings retain custom timeouts; complex owned sections currently require manual migration.

Recognized native plugin duplicates and managed native/MCP overlaps are repaired. Custom entries under other names remain untouched; inspect them before removing duplicate browser tools. General duplicate MCP-name repair is still being expanded.

After setup, the CLI offers graceful restart for supported running desktop applications. Use `--restart` for an explicit noninteractive request. Declining leaves a pending reload. Terminal sessions receive reconnect/relaunch instructions. Setup never force-kills applications. Uninstall removes selected client registrations and known skill files; shared runtime data and caches are retained.

DeepSeek discovery respects `DSH_HOME` and defaults to the `web` profile's `cordis.patch.yml`. Initialize the profile with `dsh web` first; use `--config dsh=...` for another initialized profile. Setup preserves unrelated YAML rows, comments, expressions, server names, and custom timeouts. It updates the legacy `mcp-browser` row or inserts the official MCP client when no browser row exists. Uninstall removes an inserted client or disables a bundle-owned client so the earlier layer cannot reactivate it. Reconnect MCP or relaunch the profile to load updated tools. This follows the [official profile composition contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md).

Compatible commands remain: `install`, `configure`, and `uninstall --client opencode|opencode-mcp|codex|claude-code|claude-desktop|dsh|skills`. Other MCP clients can run `opencode-chromium-mcp` as a stdio server. HTTP transport is documented in [the MCP guide](docs/mcp.md).

## Providers and offline use

Cloud decisions are off by default. In **Settings → Jev decisions**, select OpenRouter or TypeSafe, paste an API key, and choose **Save & test connection**. A timed key check and one small, billable synthetic decision verify access before saving. Keys stay in private native-host state, never browser storage or tool responses. **Overview → Jev usage** shows calls, response times, reported tokens, and reported cost.

```sh
# Set OPENROUTER_API_KEY securely in the native host environment first.
opencode-chromium providers configure --provider jev --route openrouter --share-text
opencode-chromium providers status
opencode-chromium providers configure --provider off
```

Enabling Jev authorizes bounded search/replay intent and candidate descriptions to the selected service. Jev ranks page targets and selects saved recipes for an explicit `memoryIntent`; exact recipe replay needs no cloud call. Recipe selection stays profile/site scoped and cannot bypass live target checks or approvals. Timeouts and abstentions preserve local fallback. No automatic provider fallback occurs. Screenshots are not sent. OpenAI Decisions API / Luna remains unavailable until its official request contract and account access are verified.

The [provider guide and initial live measurements](docs/DECISION-PROVIDERS.md) report better synthetic synonym matching at higher latency than lexical search. Complete browser-flow speedups are not yet established.

Without a cloud provider, explicit browser actions and lexical retrieval need no cloud inference. Existing local semantic models remain available during migration and may require an initial model download. The first compatible migration release will announce deprecation; an optional legacy package and removal in a subsequent major must precede retirement by at least 90 days. Existing memory databases and model caches remain intact. The optional package and core dependency removal are not yet complete.

## Developer channels

```sh
bun install
bun run build
bun run build:extension
bun src/cli/index.js link --follow-branch
bun src/cli/index.js sync
```

Branch following maps clean `master` to production and other branches to development. Detached HEAD retains the active channel. Each full-stack snapshot includes compiled runtime, native host, skills, and extension. The fingerprint includes source, package metadata, lockfile, and build configuration. Builds are serialized; a failed build retains the previous active snapshot. Active client work defers activation.

Load the returned stable developer-extension path once. Successful activation publishes the selected extension there and reports pending reload: reload it through the browser's extensions page and reconnect tools. Automatic developer-control reload and protocol-handshake checks are still being completed. Store-installed extensions use the browser's normal update mechanism.

Updates and channel switches retain the established memory, provider settings, credentials, usage history, and model-cache paths. Explicit environment path overrides remain authoritative. Developers who need isolated state can opt in with `stateIsolation: true` in the runtime manifest; selecting a production build alone never changes the data namespace. Git hooks never terminate native hosts or silently restart desktop applications.

## File upload consent

**Settings → File uploads → Allow uploads without confirmation** is unchecked by default and stored in the browser profile. Each upload opens an extension-owned request showing the destination, file names, sizes, optional bounded raster previews, and file locations. Choose **Allow upload** to send those files; **Cancel upload**, closing the window, or a one-minute timeout sends nothing. An agent's tool approval token cannot authorize this user decision.

Enabling the setting lets agents send any accessible local files to websites without a per-upload user prompt; file access restrictions still apply. Both file-input uploads and file drags pass through the extension consent gate, including direct CDP calls. Changed files or destinations require a new request. Approved bytes are copied into private temporary snapshots so later form submission reads the approved content. Copies are removed when the page closes or navigates, the native host exits, or after 24 hours. Batches allow up to 20 files, 256 MiB per file and 512 MiB total. Agents cannot control the confirmation window. Agent-controlled tabs intercept native file choosers so automation does not open Explorer, Finder, or a Linux file picker; detaching restores ordinary browser behavior. Older extensions must be reloaded before the updated runtime allows uploads.

## Browser behavior and documentation

Browser actions operate in background tabs. Sessions support explicit profile selection, tab ownership, approvals, bounded read retries, mutation uncertainty, screenshot delivery, and artifact-backed evidence. The harness supplies the action sequence. Providers cannot supply executable code or bypass approvals.

Controlled tabs show an agent cursor: it glides to the element an action is about to use, animates what that action is, and carries a small pill with the session's name. Each session gets its own colour, so concurrent agents are distinguishable. It animates only while its tab is on screen and its window is focused; background work places it without spending animation frames. The design is ported from the MIT-licensed [Cua Driver](https://github.com/trycua/cua) cursor overlay, with attribution in the source.

- [Action memory](docs/action-memory.md)
- [Privacy](docs/PRIVACY.md)
- [Security policy](SECURITY.md)
- [Contributor guidance](CONTRIBUTING.md)
- [Architecture and migration status](docs/architecture.md)

## Development checks

```sh
bun run build
bun run build:extension
bun run typecheck:extension
bun run check
bun run pack
bun run test:tarball
```

New production modules have a 500-line ceiling. Existing larger modules have documented, bounded migration exceptions. Strict TypeScript checks cover migrated modules; remaining JavaScript is undergoing conversion. Generated extension bundles and local reports are ignored. The npm package includes compiled runtime, extension assets, skills, metadata, and user documentation.

## Community and license

Propose features through [GitHub Discussions](https://github.com/Quindart-com/opencode-chromium/discussions). Report defects through repository issues and follow SECURITY.md for vulnerabilities. MIT licensed.
