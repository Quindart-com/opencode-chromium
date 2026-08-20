# Browser troubleshooting

Read the matching topic on demand before retrying a failed browser
connection. Each topic describes the failure it covers and the recovery
steps to try in order.

## discovery

Covers: browser setup succeeds (the native host is installed and the
extension is present) but profile discovery or tab selection fails —
for example the `browser_session` open step reports no usable profile,
or a claimed tab turns out to be stale.

Recovery, in order:

1. Call `browser_session` action `open` again without specifying a
   profile label; the runtime resolves the default profile. If the
   named profile was the issue, this isolates it.
2. Check that the browser is running and unlocked (a locked profile
   directory makes discovery report nothing). Unlock or relaunch the
   browser, then retry.
3. If a tab binding is reported missing, stale, or closed, discard
   that binding and obtain or create a fresh tab from the session
   — an empty tab list is normal after cleanup and does not invalidate
   the session.
4. Only an explicit browser-disconnected error invalidates the
   session; do not treat per-tab staleness as a session failure.

## installation

Covers: the native host or the extension is missing, unregistered, or
silently failing — for example `install-native-host` or `doctor`
reports a disconnected host, messaging times out, or the browser never
receives commands.

Recovery, in order:

1. Run `install-native-host` or the equivalent setup command from
   `docs/profiles.md` for your client, then run the doctor command
   (`doctor --budget N`) and read its report.
2. Confirm the browser extension is enabled in the browser's extension
   page (edge cases: brave and edge use their own extension stores;
   the host manifest covers multiple extension ids).
3. Refresh the extension page or restart the browser, then retry the
   connection. The host re-registers itself on restart.
4. If the host still reports `disconnected`, inspect the host log
   path printed by `doctor` for a registration error and rerun the
   installer, which repairs the native messaging registration.