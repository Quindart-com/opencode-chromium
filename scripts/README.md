# Setup and diagnostics

All repository commands use Bun.

## Native host

```powershell
bun run install:native-host -- --auto --browsers all
bun run check:native-host -- --json
```

## Browser and extension checks

```powershell
bun run list:browsers
bun run check:browser-running -- --browser chrome
bun run check:extension -- --browser chrome --extension-id <extension-id>
bun run find:extension -- brave
```

## Build and release checks

```powershell
bun run build
bun run check:schemas
bun run check:package
bun run check:mcp
bun run check:public-hygiene
bun run test:opencode
bun run pack
bun run test:tarball
bun run check:release
bun run check:tag -- v1.5.0
```

The CLI owns client configuration. Use `opencode-chromium install|configure|uninstall --client ... --dry-run` before changing a real client configuration.
