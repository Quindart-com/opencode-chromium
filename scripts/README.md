# Scripts

Setup, check, and development helper scripts for the OpenCode Chromium browser plugin.

## Install Native Host

After loading `extension/` as an unpacked extension, install native messaging manifests for every detected Chromium browser:

```bash
node scripts/install-native-host.js --auto --browsers all
```

Or copy an extension ID from `chrome://extensions`, then run:

```bash
node scripts/install-native-host.js --extension-id <extension-id> --browsers chrome
```

For Brave, you can try detecting the unpacked extension ID with:

```bash
node scripts/find-extension-id.js brave
```

For multiple Chromium browsers:

```bash
node scripts/install-native-host.js --extension-id <extension-id> --browsers chrome,edge,brave,chromium
```

## Check Native Host

```bash
node scripts/check-native-host.js --json
```

Validate a specific extension ID:

```bash
node scripts/check-native-host.js chrome --extension-id <extension-id> --json
```

## Diagnostics

List installed Chromium-family browsers:

```bash
node scripts/installed-browsers.js --json
```

Check whether Chrome is running:

```bash
node scripts/chrome-is-running.js --browser chrome --check --json
```

Check whether the OpenCode Browser extension is installed and enabled in a profile:

```bash
node scripts/check-extension-installed.js --browser chrome --extension-id <extension-id> --json
```

Preview the command that would open the selected profile:

```bash
node scripts/open-browser-window.js --browser chrome --dry-run --json
```

Open the selected profile after user confirmation:

```bash
node scripts/open-browser-window.js --browser chrome
```
