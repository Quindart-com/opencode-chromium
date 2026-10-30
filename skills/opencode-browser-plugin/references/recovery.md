# Startup and connection recovery

## Human authorization

An automatic approval-review rejection should trigger the harness's human-question tool with Approve / Disapprove, including the action and rejection reason. Keep the workflow pending while the user answers. A new approval resumes the original permission path; it does not authorize bypass through another harness. A closed or expired upload confirmation is UPLOAD_CONFIRMATION_REQUIRED, while an explicit refusal is UPLOAD_USER_DECLINED. Preserve prepared files and existing sessions. An actual human refusal needs a new user instruction.

Check the failing layer before changing an installation. A visible skill is a local file; the MCP process must separately start and advertise its tools. The extension's connected indicator describes its native-host connection, not Codex's MCP startup.

The extension's Harness connections panel updates automatically and reports observed client identity hints, loaded runtime versions, initialization/tool-call evidence and heartbeat freshness. A responding bridge is not proof that a harness registered tools. Connection help contains diagnostics and local bridge reconnect; reconnect preserves tabs and provider keys and requires browser work to finish first. Connection reporting requires a matching runtime; older hosts explicitly report that it is unavailable.

For an unpacked extension stuck on an old version, inspect its exact Loaded from path. Browser reload does not compile source. From the intended source checkout, run `bun src/cli/index.ts dev-extension --source <checkout> --output <loaded-extension-directory>` and reload the extension. The dev label includes a source fingerprint; publication retains a backup and does not change the production runtime selection. Source checkout/merge hooks refresh an explicitly linked development path through sync.

## Skill visible, browser tools missing

Report **MCP_TOOLS_UNAVAILABLE** and explain that the skill is installed but the chat's browser tools were not registered. Codex can retain a failed connection after the launcher or installation has been repaired. Give the user this targeted recovery:

1. Open **Plugins → OpenCode Browser Plugin → Manage**.
2. **Disable the plugin, then enable it again.** Keep Codex and the other agents running; do not uninstall the plugin or restart the app.
3. Return to the same chat, invoke the skill again, and retry `browser_session` once with the intended profile.

Reloading only the skill does not reconnect its MCP server. A green extension badge, matching versions or a fresh-process `tools/list` cannot establish that the affected chat has tools. Verify the actual chat after reloading, then perform one harmless browser action. If this still fails, stop requesting reloads and investigate the failing layer once:

1. Read the installed plugin's `.mcp.json` if available to identify its package version and command. Run the bundled diagnostic using the absolute path to this skill's `scripts/diagnose-mcp.mjs`:

   ```sh
   node /absolute/path/to/skill/scripts/diagnose-mcp.mjs --version VERSION --tools-unavailable
   ```

   Replace `VERSION` with the installed plugin's exact package version. The script first tests the bundled plugin's actual `.mcp.json` command, then an already installed matching managed runtime when invoked from a standalone skill. Use `--plugin-root /absolute/installed/plugin` to select an installed plugin explicitly. The report identifies `launchSource`; only `npm_package` falls back to an npm execution. `latest` for that fallback tests the current release rather than the installed command. The script tests initialize and tools/list, opens no browser tabs, and emits a bounded JSON report without raw startup logs.

2. For `MCP_DEPENDENCY_MISSING`, when the user has asked to fix the installation, rerun once with `--repair-cache`. It validates and renames only the npm execution cache entry named in that failure, retains a backup, and retries installation. It rejects paths outside npm's configured cache. Never clear the entire npm cache, delete browser profiles, or change unrelated MCP servers.
3. For `MCP_STARTUP_TIMEOUT`, local startup exceeded 30 seconds, or legacy npm execution exceeded three minutes. Inspect the local startup error (and registry/network for an npm launch) before probing once more. An unsupported command, network failure, or missing Node.js needs its own startup error resolved; restarting the extension does not address these causes. `MCP_RUNTIME_SETUP_REQUIRED` means the local runtime must first be installed or repaired with the setup CLI, then the plugin reloaded.
4. For `MCP_CHAT_RELOAD_REQUIRED`, the fresh process passed while the caller reported missing chat tools. Follow the targeted plugin reload above if it has not already been attempted. `MCP_READY` proves only fresh-process startup. Neither result proves a working connection in the affected chat.
5. For `MCP_ACCESS_DENIED`, the diagnostic itself could not access the local runtime from its sandbox. Use the harness's available human-question tool with **Approve** / **Disapprove** for a permitted local CLI diagnostic. Do not change ACLs, reinstall the extension or infer that Codex's own MCP process failed in the same way.

## Tools exist, browser discovery fails

For transport timeouts, read the automatic CLI doctor's `recovery` result before another browser action. The connection-only check probes the live extension, rather than trusting the host's cached connected flag. A healthy result does not prove that the original mutation failed or succeeded. Inspect that same session's tabs, health and current page before continuing. The runtime does not replay uncertain mutations. If automatic diagnostics cannot complete, run `opencode-chromium doctor --repair-runtime --json` from a permitted local terminal and apply one targeted repair from its checks.

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

Production native-host startup schedules marketplace repair independently of MCP startup, then checks on a bounded schedule. The helper restores an enabled plugin's missing upstream source, upgrades its Git snapshot and installs through the supported Codex CLI. It verifies the actual cached plugin manifest and local launcher before recording success; same-version catalogs are rechecked after six hours and failures retry after backoff. Explicitly local or pinned catalogs, development checkouts and other marketplaces are preserved. Catalog installation does not reload a failed chat connection: Codex still owns that step.

When sharing an unresolved failure, include the error code, versions, operating system, and a synthetic reproduction. Redact local account names, absolute personal paths, profile/session IDs, private URLs, page content, credentials, and raw logs. Follow the main skill's approval rules before posting an issue.
