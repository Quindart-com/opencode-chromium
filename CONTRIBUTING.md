# Contributing

Contributions are welcome.

## Feature proposals

The roadmap is user-driven. Propose ideas as a
[feature request discussion](https://github.com/Quindart-com/opencode-chromium/discussions/categories/feature-requests)
rather than a GitHub issue:

- Describe the problem and the workflow it should unlock, not just a solution
  name. The per-category discussion template (`.github/DISCUSSION_TEMPLATE/`)
  keeps proposals structured.
- Others vote with reactions (👍/❤️); the maintainers triage voted proposals
  into roadmap items and tag them with status.
- Substantive design work (schemas, permission changes, security impact)
  should still come as a pull request that links the discussion.

## Development Setup

```bash
bun install
bun run check
```

Load `extension/` as an unpacked extension in a Chromium-based browser, then install the native messaging host with the generated extension ID:

```bash
bun run install:native-host -- --extension-id <extension-id> --browsers chrome
```

## Pull Requests

- Keep changes small and focused.
- Include tests for native-host protocol changes when practical.
- Update README or component docs when setup behavior changes.
- Do not commit generated files, browser profile data, `node_modules/`, local extension IDs, or internal reference material.

## Security-Sensitive Changes

Changes to extension permissions, native messaging, file upload behavior, clipboard access, or CDP execution should explain the security impact in the PR description.
