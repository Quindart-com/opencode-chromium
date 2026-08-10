# Troubleshooting

Run:

```powershell
opencode-browser-plugin doctor --json
bun run check:native-host -- --json
bun run check:extension -- --browser chrome --extension-id <extension-id>
```

If no profile is connected, reload the unpacked extension and reinstall the native host with the current extension ID. If several profiles are connected, pass an exact profile ID or label. If tools are duplicated, disable either native OpenCode mode or MCP compatibility mode and run `doctor` again.

For stale local builds, run `bun run build` and point clients to `dist/`. Release-fidelity testing should use the exact tarball produced by `bun run pack`.
