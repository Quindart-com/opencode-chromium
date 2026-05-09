# Contributing

Contributions are welcome.

## Development Setup

```bash
npm install
npm run check
```

Load `extension/` as an unpacked extension in a Chromium-based browser, then install the native messaging host with the generated extension ID:

```bash
npm run install:native-host -- --extension-id <extension-id> --browsers chrome
```

## Pull Requests

- Keep changes small and focused.
- Include tests for native-host protocol changes when practical.
- Update README or component docs when setup behavior changes.
- Do not commit generated files, browser profile data, `node_modules/`, local extension IDs, or internal reference material.

## Security-Sensitive Changes

Changes to extension permissions, native messaging, file upload behavior, clipboard access, or CDP execution should explain the security impact in the PR description.
