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

**The launchers are what guarantee this, not the hooks.** Before starting,
`mcp.mjs` and `plugin.mjs` compare the bundle against the checked-out sources and
rebuild when they disagree, so a branch switch can never leave a stale bundle
serving an agent. That check is self-contained — it carries its own copy of the
fingerprint function, because a checkout predating that helper is exactly when it
still has to work. If the tree itself is broken the rebuild fails and the last
good bundle starts with a warning, rather than taking the browser tools down.

`.githooks/post-checkout` and `.githooks/post-merge` are a convenience on top:
they run `sync --if-linked`, which rebuilds immediately and restarts the native
host so the browser picks up the new code without waiting for its next
reconnect. They are inert on a checkout that was never linked, and because they
belong to the branch, an older branch simply does not have them — correctness
does not depend on them.

Because the bundle records a `sourceSha256` of everything that feeds it,
"is my build current?" is an exact answer rather than a guess.

## Verifying

`bun run status` prints one table: the runtime directory, the linked root, the
branch and revision, bundle freshness, the browser registration, any running
hosts, skill parity, and each agent surface with the path it points at. A
non-zero `doctor` exit or a `DRIFT` marker means exactly one surface needs
attention.

The status launcher lives outside the branch, so the question is answerable even
on a checkout that predates these commands:

```powershell
node "$env:LOCALAPPDATA\OpenCode\browser\status.mjs"
```

## Notes

- `link` registers the browsers that are **installed**, plus any already
  registered, so it never creates registrations for browsers that are not there
  and never drops a working one. `check:native-host` checks the same set and
  reports the rest as skipped; `--all` checks every browser anyway.
- Extension ids from every available source are merged rather than replaced:
  profile scanning cannot read preferences while a browser is running, so the
  existing manifest and `scripts/extension-id.json` fill the gaps.
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
