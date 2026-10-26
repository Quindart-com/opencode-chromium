# Automatic runtime activation

Run `npx -y opencode-chromium@latest setup --all` and reconnect MCP once to adopt the managed supervisor. Setup installs a complete immutable release and copies the supervisor and its built-in-only dependencies into the user's runtime directory. The packaged Codex plugin uses `opencode-chromium-mcp --managed` to share this installation. Initial setup may need npm access; dry runs do not install anything.

When the extension announces a newer version, the native host installs that exact npm release in a unique staging directory, validates it and renames it into `releases/<version>`. Downloads do not block browsing or replace global npm files. Unavailable or invalid releases retain the current runtime and retry after six hours.

## Global session boundary

Activity is shared across processes and profiles, rather than inferred from the lifetime of a harness or socket. Open sessions, paused agents, pending approvals, handoff tabs, unfinished cleanup, traces and in-flight work prevent activation. New sessions remain allowed while a downloaded update waits. Finish work with `browser_finalize`; use `deliverable` for output tabs that should remain open without retaining a session.

Adapters register activity before dispatch, and native hosts gate uncoordinated ingress too. Every registered extension independently confirms that it has no retained sessions or unfinished commands. Older clients without activity reporting remain conservative blockers until reconnected. Unknown or corrupt activity records prevent activation. A crashed process's retained session is not cleared solely because its PID exited: associated profiles must independently confirm idle, and unresolved approvals remain blockers.

At the first verified global boundary, a journal closes the shared request-admission gate. Each supervisor warms a replacement worker, internally initializes MCP and compares its tool schemas, negotiated capabilities and resource templates against the existing connection. New calls queue temporarily. After every supervisor acknowledges readiness, the runtime pointer and generation are committed atomically. Supervisors switch workers without closing harness stdio connections or sending another initialization response to the harness.

A separate coordinator process keeps the gate closed while idle native hosts exit and their extensions reconnect them to the selected release. It verifies every previously connected profile before reopening admission. Keeping coordination outside native hosts allows replacement of the host that downloaded the update. No browser or harness application is forcibly restarted.

## Compatibility and recovery

The supervisor protocol is versioned separately from releases. Compatible workers preserve public tool contracts and result formatting, images, resources, IDs, notifications and cancellation forwarding. Instructions and descriptions already advertised to a harness remain that connection's snapshot. Contract or supervisor incompatibility reports `reconnect_required`; run setup and reconnect once to adopt that change.

Preparation, commit acknowledgement and host reconnection have bounded deadlines. Failure before admission resumes restores the previous runtime pointer; previous workers and immutable releases remain available during rollback. The atomic pointer is authoritative after a coordinator crash, and each supervisor reconciles it before its next dispatched call. Interrupted mutations return an uncertain error and are never automatically replayed. A replacement worker can handle subsequent calls; agents must re-observe after an uncertain result.

Use `opencode-chromium updates status` or **Settings → Updates** to inspect selected, downloaded and loaded versions, update state and participant blockers. `updates off` prevents automatic activation even if a release is already downloaded. Disabling updates during preparation aborts that switch.

Automatic worker replacement covers managed core stdio MCP clients. OpenCode's native adapter reports activity and blocks unsafe switches, but its adapter code remains loaded until OpenCode reloads. Explicit version pins, development/follow-branch installations, standalone HTTP and legacy/debug commands keep their existing manual policy. The managed launcher retains development build checks.
