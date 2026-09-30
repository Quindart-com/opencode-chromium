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
| Other MCP clients | Standard stdio server | Client-dependent |

These are configuration targets, not a claim that every installed client version has passed live testing. OpenCode uses `plugin` for the detected 1.x contract and `plugins` for 2.x. Native and MCP browser registrations are mutually exclusive in the managed OpenCode configuration. Missing clients remain visible; unsupported platform combinations show their limitation.

## Manage registrations

```sh
opencode-chromium manage
opencode-chromium setup --targets codex,opencode --dry-run --json
opencode-chromium setup --targets claude-code --config claude-code=/absolute/config/path --json
opencode-chromium update --targets codex,opencode --json
opencode-chromium uninstall --targets codex --json
```

`setup`, `manage`, and `update` reconcile registrations with the installed runtime. Upgrade the npm package before `update`; it does not independently download a release. With `--json` and no targets, these commands only report discovery. Noninteractive changes require `--targets`. Configuration overrides are repeatable `--config harness-id=/path` values. Discovery respects `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`.

Configuration changes and selected-client skills are planned before writing, backed up, written atomically, and rolled back if a later file change fails. Dry runs leave configuration and skills untouched. JSONC edits preserve unrelated comments. Existing simple Codex TOML settings retain custom timeouts; complex owned sections currently require manual migration.

Recognized native plugin duplicates and managed native/MCP overlaps are repaired. Custom entries under other names remain untouched; inspect them before removing duplicate browser tools. General duplicate MCP-name repair is still being expanded.

After setup, the CLI offers graceful restart for supported running desktop applications. Use `--restart` for an explicit noninteractive request. Declining leaves a pending reload. Terminal sessions receive reconnect/relaunch instructions. Setup never force-kills applications. Uninstall removes selected client registrations and known skill files; shared runtime data and caches are retained.

Compatible commands remain: `install`, `configure`, and `uninstall --client opencode|opencode-mcp|codex|claude-code|claude-desktop|skills`. Other MCP clients can run `opencode-chromium-mcp` as a stdio server. HTTP transport is documented in [the MCP guide](docs/mcp.md).

## Providers and offline use

Cloud decision assistance is disabled by default. Jev can assist finite page-target ranking through TypeSafe directly or OpenRouter. Keys stay in the native host's environment; preferences contain only credential references. The extension settings expose provider selection and explicit text-sharing consent.

```sh
# Set OPENROUTER_API_KEY securely in the native host environment first.
opencode-chromium providers configure --provider jev --route openrouter --share-text
opencode-chromium providers status
opencode-chromium providers configure --provider off
```

Jev does not receive screenshots. Timeouts, invalid candidates, and abstentions fall back to deterministic results. No automatic provider fallback occurs. OpenAI Decisions API / Luna is shown as unavailable preview support until its official request contract and account access are verified.

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

Channel launchers isolate memory, provider settings, model caches, artifacts, and profile registries. Git hooks never terminate native hosts or silently restart desktop applications. Existing direct links retain their compatible behavior; run branch following explicitly to opt into full-stack snapshots.

## Browser behavior and documentation

Browser actions operate in background tabs. Sessions support explicit profile selection, tab ownership, approvals, bounded read retries, mutation uncertainty, screenshot delivery, and artifact-backed evidence. The harness supplies the action sequence. Providers cannot supply executable code or bypass approvals.

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
