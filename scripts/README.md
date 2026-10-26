# Setup and diagnostics

`bun run verify:reliability` checks the real Chromium extension, native messaging host, and four-tool runtime with a disposable profile and a unique temporary native-host registration. Build the runtime and Chromium extension first, then run `bunx playwright install chromium`. It covers target identity, focus, embedded uploads, and native-dialog recovery without touching personal profiles.

`node scripts/verify-firefox-uploads.js --frames` checks consent and application file processing in a cross-origin frame. Use `--librewolf` to select LibreWolf, or `OPENCODE_FIREFOX_TEST_EXECUTABLE` to select a stock Firefox test binary. The real add-on/native-host path is covered by `node scripts/verify-firefox-extension.js`, including frame input and prompt recovery.

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
bun run test:opencode
bun run pack
bun run test:tarball
bun run check:release
bun run check:tag -- v<package-version>
```

The CLI owns client configuration. Use `opencode-chromium install|configure|uninstall --client ... --dry-run` before changing a real client configuration.
