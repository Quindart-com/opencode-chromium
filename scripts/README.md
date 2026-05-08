# Scripts

Setup, check, and development helper scripts for the OpenCode Chromium browser plugin.

## Install Native Host

After loading `extension/` as an unpacked extension, copy its extension ID from `chrome://extensions`, then run:

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
node scripts/check-native-host.js
```
