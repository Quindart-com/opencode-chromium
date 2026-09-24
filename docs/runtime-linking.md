# One runtime, one switch point

Every OpenCode Chromium surface - the browser's native messaging host, the
OpenCode plugin, the Codex MCP server, DSH, and the installed skills - points at
a single stable install directory instead of at a checkout. The directory
contains three tiny launchers plus one pointer:

| OS | Runtime directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\OpenCode\browser` |
| macOS | `~/Library/Application Support/OpenCode/browser` |
| Linux | `~/.config/opencode/browser` |

```
opencode-browser-host.cmd   (Windows) / opencode-browser-host (unix)
host.mjs                    resolves the native host from the active root
mcp.mjs                     resolves the MCP server
plugin.mjs                  resolves the OpenCode plugin
runtime.json                { "root": "<absolute path to the active root>" }
```

Nothing in that list is version-specific, so **no registration or client config
ever has to change again** — not when you switch branches, not when you upgrade,
not when you point at a different checkout.

## Commands

```powershell
bun run link      # once per machine: write the launchers, register the browser
                  # host, point every client at the launchers, install skills
bun run status    # what is actually live, and where it drifts
bun run sync      # rebuild a stale bundle and restart the native host
```

`link` is idempotent and backs up every configuration file it rewrites.

## Branch is the channel

`runtime.json` points at a checkout, and the branch you have checked out in that
checkout is the version that runs. `dev` holds work in progress; `master` is the
stable line.

```powershell
git checkout dev      # work here
git checkout master   # stable, no reinstall, no commands to remember
```

Two hooks keep that honest, and both are inert unless the checkout was linked:

- `.githooks/post-checkout` and `.githooks/post-merge` run
  `sync --if-linked`, which rebuilds `dist/` when the source no longer matches
  the bundle and restarts the native host so the browser picks up the new code.
  The extension respawns the host on demand, so the restart costs nothing.
- The MCP and plugin launchers also verify the bundle themselves before
  starting: a stale bundle is rebuilt on the spot, and if the tree itself is
  broken the last successful bundle still starts, with a warning, rather than
  taking the browser tools down.

Because the bundle records a `sourceSha256` of everything that feeds it,
"is my build current?" is an exact answer rather than a guess.

## Verifying

`bun run status` prints one table: the runtime directory, the linked root, the
branch and revision, bundle freshness, the browser registration, any running
hosts, skill parity, and each agent surface with the path it points at. A
non-zero `doctor` exit or a `DRIFT` marker means exactly one surface needs
attention.

## Notes

- The native host runs from `native-host/src`, so a branch switch takes effect
  on the next host start with no build step; only `dist/` (the MCP server and
  plugin) needs rebuilding.
- `link` refreshes the installed skill copies, which is what keeps agent
  guidance in step with the code.
- Set `OPENCODE_BROWSER_RUNTIME_DIR` to relocate the runtime directory, for
  example to keep several configurations side by side.
- `patchDshConfig` rewrites only the one argument that names the browser MCP
  entry in `~/.dsh/profiles/web/cordis.patch.yml`, so hand-written comments
  survive. DSH must be restarted before it picks up the new entry.
