# Contributing

Contributions are welcome.

## Bug reports and questions

Use the [bug report form](https://github.com/Quindart-com/opencode-chromium/issues/new?template=bug_report.yml) for broken behavior. Include reproduction steps, expected and actual results, runtime and extension versions, browser, operating system, and client details. Unknown versions are acceptable; a small example with synthetic data is more useful than a large private log.

Issues and attachments are public. Remove credentials, cookies, personal information, private URLs, local user paths, and confidential page contents. Do not upload browser profiles or full configuration files. Follow [SECURITY.md](SECURITY.md) for vulnerability reports, and use [Discussions](https://github.com/Quindart-com/opencode-chromium/discussions) for usage questions.

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
- Reference related issues in the PR description. Use closing keywords only after verifying the reported workflow; otherwise state what still needs confirmation.
- Do not commit generated build output, raw screenshots, browser profile data, `node_modules/`, local extension IDs, or internal reference material. The Codex manifest and small sanitized benchmark SVG/JSON snapshots are intentional versioned release inputs.
- Keep new production modules below 500 lines. Existing migration exceptions are bounded in `architecture-exceptions.json`; increases require an explicit rationale in review.
- Follow the [subsystem boundaries and migration status](docs/architecture.md). Validate contracts through behavior, including cancellation, failure, dry-run preservation, rollback, and mutation uncertainty.
- Keep credentials and private benchmark/history inventories outside the checkout. Preserve runtime redaction, privacy behavior, synthetic fixtures, and ordinary secret scanning.

## Test scope

Add tests for distinct failures in production behavior. Extend an existing fixture when it already exercises the affected flow. Avoid tests that only search source code for helper names, repeat package/schema checks, copy SVG coordinates or CSS constants, or assert facts about a mock without calling production code.

Keep coverage for ownership isolation, consent, redaction, startup and update recovery, cancellation, mutation uncertainty, and supported Node/platform behavior. Real browser checks cover DOM interaction and rendering; small unit tests should cover additional boundaries or failure paths instead of repeating that flow.

## Security-Sensitive Changes

Changes to extension permissions, native messaging, file upload behavior, clipboard access, or CDP execution should explain the security impact in the PR description.

## Releases

`package.json` is the only manually managed release version. Use `npm version <version> --no-git-tag-version`; the version lifecycle synchronizes Codex's required literal manifest version. The build also synchronizes it, and CI checks for drift before building. Extension manifests derive their version from the package. Add the complete release notes at `docs/releases/<version>.md`. Run the complete release gate before merging:

```bash
bun run build
bun run build:extension
bun run build:extension:firefox
bun run check
bun run pack
bun run test:tarball
bun run check:release
```

After the version bump reaches `master`, GitHub Actions publishes npm with Trusted Publishing, submits both browser extensions, and creates the matching `v<version>` GitHub release from the versioned release notes. npm/GitHub release creation does not wait for store review. Store submission workflows report their own result, preserve verified artifacts and can be retried without republishing npm. Do not create the root package tag manually. The compatibility shim under `packages/opencode-chromium-mcp` retains its separate `opencode-chromium-mcp-v<version>` release tag because it has an independent version lifecycle.

Before merging a release, run the Chrome and Firefox workflows on the PR branch with `dry_run: true`. Chrome validates credentials, package and current store readiness without uploading; Firefox validates the source archive and authenticates a read-only AMO query. Offline source-archive checks can still use `bun run firefox:submit -- --dry-run` without credentials.
