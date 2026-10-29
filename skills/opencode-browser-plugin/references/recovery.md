# Startup and connection recovery

Check the failing layer before changing an installation. A visible skill is a local file; the MCP process must separately start and advertise its tools. The extension's connected indicator describes its native-host connection, not Codex's MCP startup.

## Skill visible, browser tools missing

1. Read the installed plugin's `.mcp.json` if available to identify its package version and command. Run the bundled diagnostic using the absolute path to this skill's `scripts/diagnose-mcp.mjs`:

   ```sh
   node /absolute/path/to/skill/scripts/diagnose-mcp.mjs --version VERSION
   ```

   Replace `VERSION` with the installed plugin's exact package version. If unavailable, use `latest` and disclose that this tests the current release rather than the installed command. The script tests initialize and tools/list, opens no browser tabs, and emits a bounded JSON report without raw startup logs.

2. For `MCP_DEPENDENCY_MISSING`, when the user has asked to fix the installation, rerun once with `--repair-cache`. It validates and renames only the npm execution cache entry named in that failure, retains a backup, and retries installation. It rejects paths outside npm's configured cache. Never clear the entire npm cache, delete browser profiles, or change unrelated MCP servers.
3. For `MCP_STARTUP_TIMEOUT`, installation or startup exceeded the helper's three-minute budget. Inspect the registry/network and local startup error before probing once more. An unsupported command, network failure, or missing Node.js needs its own startup error resolved; restarting the extension does not address these causes.
4. For `MCP_READY`, if the current chat still lacks the tools, reconnect MCP or fully reopen Codex and start a new chat. Say that the fresh process passed, and verify the actual chat's tool availability after reconnect. Then run a browser action. Do not equate tools/list with a working browser connection.

## Tools exist, browser discovery fails

| Error | Recovery |
| --- | --- |
| `BROWSER_HOST_UNRESPONSIVE` | Run `opencode-chromium doctor --repair-runtime --json` from the installed release. This removes records belonging to dead, idle processes while retaining unfinished sessions and approvals. Retry once, then reconnect the extension if its host still fails to answer. |
| `BROWSER_HOST_ACCESS_DENIED` | Explain that the server cannot access the registered local host. Use the client's permitted local-server execution or approval mechanism. Reinstalling the extension does not grant sandbox access. |
| `NO_BROWSER_PROFILE` | Check that the browser is running and its extension is enabled and connected; use the installation/discovery topics in the troubleshooting guide. |
| `PROFILE_SELECTION_REQUIRED` | Use the user's intended profile; do not select an unrelated signed-in profile. |

Use the installed CLI directly if npm startup is broken; after repairing the cache, `npx -y opencode-chromium@latest doctor --repair-runtime --json` is an alternative. Explain that a version mismatch may require an update, while missing tools with matching versions may be a startup failure.

## Codex shows an older plugin version

The plugin catalog, installed skill, npm CLI, browser extension, and managed runtime have separate lifecycles. The listing's version is not proof of the running server's version.

For released versions, register the GitHub marketplace once:

```sh
codex plugin marketplace add Quindart-com/opencode-chromium --ref master --sparse .codex-plugin --sparse .agents/plugins --sparse skills --sparse docs --sparse assets
```

Refresh an existing snapshot with `codex plugin marketplace upgrade quindart-browser`, reopen the plugin browser, choose Quindart Browser, and install/update the displayed release. An older open development checkout can expose its own older project catalog. GitHub-backed marketplaces still use local snapshots; do not promise that Codex polls a raw GitHub file on every request or immediately adopts every upstream change.

When sharing an unresolved failure, include the error code, versions, operating system, and a synthetic reproduction. Redact local account names, absolute personal paths, profile/session IDs, private URLs, page content, credentials, and raw logs. Follow the main skill's approval rules before posting an issue.
