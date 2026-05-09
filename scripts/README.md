# Setup Scripts

Setup and diagnostic helpers for the OpenCode Chromium browser plugin.

## Install Native Host

After loading `extension/` as an unpacked extension, install native messaging manifests for every detected Chromium browser:

```bash
bun run install:native-host -- --auto --browsers all
```

Or copy an extension ID from `chrome://extensions`, then run:

```bash
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
```

You can try detecting the unpacked extension ID with:

```bash
bun run find:extension -- brave
```

For multiple Chromium browsers:

```bash
bun run install:native-host -- --extension-id <extension-id> --browsers chrome,edge,brave,chromium
```

## Check Native Host

```bash
bun run check:native-host -- --json
```

Validate a specific extension ID:

```bash
bun run check:native-host -- chrome --extension-id <extension-id> --json
```

## Diagnostics

List installed Chromium-family browsers:

```bash
bun run list:browsers
```

Check whether Chrome is running:

```bash
bun run check:browser-running -- --browser chrome
```

Check whether the OpenCode Browser extension is installed and enabled in a profile:

```bash
bun run check:extension -- --browser chrome --extension-id <extension-id>
```

Preview the command that would open the selected profile:

```bash
bun run open:browser -- --browser chrome --dry-run
```

Open the selected profile after user confirmation:

```bash
bun run open:browser -- --browser chrome
```
