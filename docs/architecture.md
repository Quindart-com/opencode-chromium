# Architecture

The four public browser tools share one runtime. MCP, OpenCode and JavaScript adapters translate that contract; browser-specific behavior stays below it.

| Module | Responsibility |
| --- | --- |
| `src/core` | Session lifecycle, approvals, output budgets, artifacts and optional capabilities |
| `src/browser` | Browser operations, URL/file policy, environment cleanup and network redaction |
| `src/browser/operations/*-expressions.ts` | Focused page extraction and interaction helpers |
| `src/management` | Transactional setup, configuration migration, backup and rollback |
| `extension-src/entrypoints/background` | Native transport, owned tabs, trusted input and browser events |
| `native-host/src/firefox` | Loopback BiDi connection, verified tab/frame bridges and protocol translation |
| `native-host/src/decisions` | Opt-in decision providers, cancellation, bounded context and local fallback |
| `native-host/src/memory` | Optional local action signatures, retrieval and replay validation |

New modules have a 500-line ceiling. Existing large modules have explicit, decreasing budgets in `architecture-exceptions.json`; extract a responsibility without changing its contract. Management code must not import browser orchestration, and native-host decision code depends only on its subsystem and shared value contracts.

Production CLI, runtime and extension modules use strict TypeScript. Native-message, stored-memory and operation-result boundaries validate untrusted values. The CLI loads command modules on demand; local inference libraries load only when a model is needed. Effect owns embedding concurrency and cancellable child processes. npm packages contain compiled JavaScript and public declarations.

Run `bun run check` for typechecks, lint, dependency/architecture/schema checks and behavior tests. `bun run test:tarball` validates the published package layout and a TypeScript consumer using production dependencies. Browser fixture scripts use disposable profiles or headless instances and must never reset a user's occupied browser.
