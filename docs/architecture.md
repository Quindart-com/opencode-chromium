# Architecture

`opencode-browser-plugin` has one provider-neutral runtime and thin client adapters:

```text
MCP / OpenCode V2 / direct SDK
          |
    four-tool registry
          |
     AgentBrowserRuntime
          |
  sessions, profiles, approvals,
 retries, settling, artifacts, search
          |
 browser operation engine (49 primitives)
          |
 profile IPC -> native host -> extension -> Chromium
```

`src/core/` owns semantics and contracts. `src/browser/` owns extension/native-host IPC, profiles, CDP, tabs, DOM, downloads, and the preserved granular operation registry. `src/adapters/` only translates schemas and protocol results. No adapter reimplements browser behavior.

The four public tools are permanent. Capability manifests are requested through `browser_observe` and advanced capabilities execute inside `browser_run`; clients do not need to accept dynamic tool-list changes. The `network` pack is tab-scoped and lazy, so network diagnostics do not enter the default schema or legacy 49-operation surface.

## Lifecycle

Sessions bind to one live profile and track their active and owned tabs. Profile selection is automatic only for one connected profile; multiple profiles require an exact ID or label. Reconnects invalidate stale connection generations and never silently reroute a session.

Read operations use bounded retries and stale-target recovery. Consequential writes are preflighted, require an immutable short-lived approval token, and are never repeated after uncertain dispatch. Settling and post-observation are part of the same runtime turn.

Results default to 4,096 characters. Oversized JSON and screenshots are stored in session-scoped expiring artifacts with bounded inline previews.
