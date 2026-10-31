# Runtime operations

opencode-chromium separates the globally installed CLI, stable controller, desired managed release, active workers, harness adapters, and browser extension. They can legitimately have different versions. Compatibility is negotiated from control-protocol and tool-contract capabilities, not version equality.

Run `opencode-chromium setup --all` once to install the fixed controller and stable `host.mjs`, `mcp.mjs`, and `plugin.mjs` launchers. Harness and native-messaging configuration always targets those launchers, never a release directory or source checkout. Credentials, memory, artifacts, profiles, and settings remain in stable data directories outside immutable releases.

## Blue-green activation

An update is downloaded into a unique staging directory and checked for package identity, version, release metadata, required entrypoints, and hashes. Validation must finish before the release becomes `desired`; a merely staged release is never a fallback.

New MCP connections and browser profiles select the desired release immediately. Each connection keeps a persistent lease containing its runtime and contract version, process and harness identity, heartbeat, in-flight work, approvals, and retained sessions. An initialized connection never changes to a contract-incompatible worker underneath the client. Busy connections drain on their existing worker, while idle processes and newly opened connections adopt independently.

The last successfully active, unleased release becomes the fallback. Desired and fallback releases are retained. Older releases are eligible for collection only after seven days and only when no live lease references them. Rollback assigns fallback as desired and uses the same drain process; it does not terminate user sessions.

Compatible patch and minor releases may apply automatically. A major release requires one explicit approval showing its breaking changes. The controller updates itself by atomically preparing the next-run bootstrap while keeping capability negotiation backward compatible.

## Status and controls

The extension reports separate rows for:

- extension;
- globally installed CLI;
- stable controller;
- desired managed runtime;
- active worker versions; and
- harness or marketplace adapters.

States include available, staging, draining, blocked, major approval required, rollback available, and failed. A global CLI at 1.10.2 with a selected 1.10.1 runtime and staged 1.10.2 release is a reconcilable component mismatch, not an “old CLI.” A new extension connected to a legacy host reports that the compatibility bridge is required and never calls an unsupported update method.

The stable controller exposes `control.capabilities`, `control.status`, `control.update`, `control.job`, `control.rollback`, and `control.reconcile`. Jobs persist across host reconnection and return structured state and error codes. Recovery details sanitize connection identities and do not expose credentials or private paths.

## Profiles and sessions

The live registry distinguishes a stable profile fingerprint, optional human label, transient connection ID, browser family and version, extension version, and connection generation. One connected profile is selected automatically. Multiple profiles require an exact label or ID; duplicate labels return `PROFILE_LABEL_AMBIGUOUS`, and a disconnected selected profile returns `PROFILE_DISCONNECTED` without silently choosing another profile.

Use `browser_session` to open, create, claim, release, and name tabs. Claiming an existing page requires the user's explicit request or permission. Reconnects invalidate stale tab handles, and one session cannot claim another profile's tabs. Call `browser_finalize` when finished. Deliverable tabs remain open in a blue review group; only an explicit handoff retains ownership in the active group.

## Connection recovery

The harness panel distinguishes a responding local bridge from an initialized harness link and a received tool call. Links heartbeat every 15 seconds and become stale after 45 seconds. A successful install or reload command alone never marks a harness connected.

Use the guarded Connect or Reconnect action for the affected harness. It refreshes this plugin's configuration and supported tool catalog without restarting the application or unrelated MCP servers. Existing browser sessions remain pinned. If Codex loaded the skill but the current chat has no tools, use **Plugins → OpenCode Browser Plugin → Manage → disable → enable**, then invoke the skill again in the same chat.

For profile discovery failures, open a session again without a profile label, confirm the browser is running and unlocked, and discard only stale tab handles. A missing tab does not invalidate the whole session. For native-host failures, run setup and `doctor`, confirm the extension is enabled, then reload the extension or browser. Inspect the sanitized doctor result before reinstalling.

Harness-specific recovery is also available from the CLI:

```sh
opencode-chromium harness reconnect codex
opencode-chromium harness reconnect opencode
opencode-chromium harness reconnect dsh
opencode-chromium harness reconnect claude-code
opencode-chromium harness reconnect claude-desktop
```

Controls are restricted to trusted extension pages. Websites and browser-agent IPC callers cannot start local controller jobs.

## Local development extension

Browser reload reads the exact directory selected by **Load unpacked**; it does not rebuild source code. Publish a current development build with:

```sh
bun src/cli/index.ts dev-extension --source /absolute/current/checkout --output /absolute/loaded/extension
```

The output retains the extension ID, records a source fingerprint, and does not change the desired production runtime or provider settings. Reload the extension after publication. A development extension can use an older compatible runtime; unavailable capabilities are reported explicitly.
