# Runtime linking and developer channels

Use `setup` or `manage` for selectable client registration. See the [README](../README.md) for the unified CLI and current integration limits.

## Stable launchers

`OPENCODE_BROWSER_RUNTIME_DIR` overrides the shared runtime directory. The current default is `%LOCALAPPDATA%/OpenCode/browser` on Windows and `~/.config/opencode/browser` on macOS/Linux. Stable `host.mjs`, `mcp.mjs`, and `plugin.mjs` files read `runtime.json` at launch. Each harness still owns its server process.

The compatible `link` command registers native messaging and its legacy default client surfaces. It can detect existing extension IDs; load the browser extension first. `link --dry-run` makes no changes. `sync` never terminates native hosts: reconnect after active work finishes.

## Full-stack branch following

```sh
bun src/cli/index.js link --follow-branch
bun src/cli/index.js sync
```

Full-stack branch following creates immutable builds under the runtime directory and retains a separate active pointer. Clean `master` selects production; `dev` and feature branches select development. Detached HEAD retains the active channel. Source, lockfile, and build-configuration fingerprints invalidate stale snapshots.

A lock serializes builds. Compilation, extension version checks, and a compiled CLI smoke check precede activation. Sources changing during a build or a failed build leave the previous pointer intact. A busy browser client defers activation; rerun sync after clients disconnect. Snapshot activation does not force-kill harnesses or desktop applications.

Channel launchers separate provider preferences, memory, model caches, artifacts, and profile registries under `state/development` and `state/production`. Keys remain referenced through native-host environment variables.

Load the returned stable `extension` path unpacked once. Publication updates its files; the CLI currently reports a pending manual browser-extension reload and harness reconnect. A developer-control reload message and a framed runtime/extension handshake remain migration work. Store-installed extensions retain normal browser updates.

Git hooks run only when Bun is available and the checkout is linked. They do not restart desktop applications. Legacy direct links may still rebuild their compiled backend on launch; explicitly opt into branch following for complete snapshots.
