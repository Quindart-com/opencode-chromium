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
bun run build
bun run build:extension
bun run typecheck:extension
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
- Keep new production modules below 500 lines. Existing migration exceptions are bounded in `architecture-exceptions.json`; increases require an explicit rationale in review.
- Follow the [subsystem boundaries and migration status](docs/architecture.md). Validate contracts through behavior, including cancellation, failure, dry-run preservation, rollback, and mutation uncertainty.
- Keep credentials and private benchmark/history inventories outside the checkout. Preserve runtime redaction, privacy behavior, synthetic fixtures, and ordinary secret scanning.
- Follow [the contributor history-rewrite recovery procedure](docs/HISTORY-RECOVERY.md) after the maintainer announces a coordinated cutover.

## Security-Sensitive Changes

Changes to extension permissions, native messaging, file upload behavior, clipboard access, or CDP execution should explain the security impact in the PR description.

## Releases

`package.json` is the canonical release version. For a release PR, advance it to a higher SemVer version; the extension build derives its matching version. Run the complete release gate before merging:

```bash
bun run build
bun run build:extension
bun run check
bun run pack
bun run test:tarball
bun run check:release
```

After the version bump reaches `master`, GitHub Actions automatically publishes npm with Trusted Publishing, submits the extension, and creates the matching `v<version>` GitHub release with generated notes. Do not create the root package tag manually. The compatibility shim under `packages/opencode-chromium-mcp` retains its separate `opencode-chromium-mcp-v<version>` release tag because it has an independent version lifecycle.
