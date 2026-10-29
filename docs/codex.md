# Codex

## Native plugin

Install the plugin from this repository's marketplace:

```sh
codex plugin marketplace add Quindart-com/opencode-chromium --ref master --sparse .codex-plugin --sparse .agents/plugins --sparse skills --sparse docs --sparse assets
codex plugin add opencode-browser-plugin@quindart-browser
```

The native manifest at `.codex-plugin/plugin.json` bundles the browser skill
and `.mcp.json`. The MCP configuration runs the published `opencode-chromium`
runtime through `npx`; Node.js 20 or later is required. Sparse checkout includes
the plugin resources and documentation without fetching the development source
directories. Install the browser
extension and register its native host with `npx -y opencode-chromium@latest setup --targets codex`
before controlling a browser. See [Firefox setup](firefox.md) for Firefox profiles.

If you already registered the same MCP server manually, remove that registration
with `codex mcp remove opencode-browser-plugin` before enabling the native plugin
to avoid duplicate tools. Setup recognizes an enabled native plugin, removes a
duplicate manual browser MCP registration, and does not copy a second browser
skill. Choose either native plugin installation or manual MCP registration below.

## Marketplace updates and recovery

The marketplace installation above points directly to GitHub. Users do not need
to clone this repository or load a local development directory. Codex downloads a
snapshot; the `source.path: "./"` entry refers to the plugin inside that snapshot.
It does not mean the user must supply a local checkout.

To refresh that Git source:

```sh
codex plugin marketplace upgrade quindart-browser
```

Production setup and managed MCP startup run this supported refresh automatically once per new runtime version when the native browser plugin is enabled from `quindart-browser`. A missing CLI or failed network refresh leaves the manual command available. The runtime never edits Codex's installed-plugin cache or unrelated marketplace configuration.

Reopen Codex's plugin browser, choose **Quindart Browser**, and install/update the
displayed release. Start a new chat after reconnecting. Updating npm or the managed
runtime does not refresh Codex's plugin listing. A development checkout on an old
branch can also expose an older project catalog; `doctor` reports a project
listing that differs from the CLI version. Use the Git marketplace for releases.

Release checks already keep the plugin manifest and pinned npm version aligned.
They cannot force existing clients to refresh immediately. Git-backed catalogs
are supported by [OpenAI's marketplace documentation](https://developers.openai.com/plugins/build/plugins).

If the skill appears but tools are missing, follow the
[startup recovery guide](../skills/opencode-browser-plugin/references/recovery.md)
before repeatedly reinstalling or reloading. It distinguishes startup failures,
damaged npm cache entries, browser discovery, and permission errors.

## One-command setup

For a Codex MCP connection and browser skill without marketplace installation:

```sh
npx -y opencode-chromium@latest setup --targets codex
```

Setup registers the native messaging host for installed browsers, preserves other
servers and settings, and keeps backups of changed files. Reconnect MCP or reopen
Codex afterward. Preview the changes with `--dry-run --json`; use `setup --all`
instead to connect every detected, supported agent app.

## Manual MCP registration

Register the required MCP server named `opencode-browser-plugin` from the npm package:

```powershell
codex mcp add opencode-browser-plugin -- npx -y opencode-chromium-mcp
codex mcp list
```

`opencode-chromium-mcp` is published on npm as a standalone launcher for the
MCP server shipped inside `opencode-chromium`, so `npx` resolves it directly.

From a local checkout, register `dist/adapters/mcp/server.js` with Bun instead:

```powershell
codex mcp add opencode-browser-plugin -- bun C:\absolute\path\to\dist\adapters\mcp\server.js
```

The Codex skill is `skills/opencode-browser-plugin/SKILL.md`. It tells the agent to reuse sessions, batch actions, pass a selected profile early, request capabilities only when needed, use approval tokens exactly once, retrieve artifacts, and finalize owned tabs.
