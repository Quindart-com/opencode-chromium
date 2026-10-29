# Unreleased

- Replace the ambiguous extension status with a verified local-bridge indicator and a harness connection panel showing identity hints, versions, process IDs, heartbeats, initialization/tool-call evidence and pending commands.
- Add extension-only refresh, confirmed disconnect and safe bridge reconnect controls, with CLI doctor guidance. Preserve browser tabs and provider credentials; protect active requests, sessions and approvals.
- Announce initialized MCP and OpenCode clients, expire missed heartbeats visibly, and stop presence when adapters unload.
- Prevent delayed old native-port callbacks from breaking a replacement connection, and stop empty extension sessions from blocking runtime updates.
- Give consented image decision fallback a bounded five-second allowance while preserving the shorter text-decision deadline.
- Correct OpenCode V2 package detection, directory registration and native tool-transform compatibility.
- Add fresh development-extension publication to the existing unpacked path, with a build fingerprint, backup and rollback. Keep production runtime selection intact and repair source checkout/merge sync hooks.
- Translate the connection controls and status wording into all six shipped locales.
