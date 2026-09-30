# Architecture and staged migration

One package retains the four public tools, SDK exports, binary aliases, and granular compatibility operations. Responsibility boundaries are the migration target; moving existing modules must preserve their behavioral contracts.

| Subsystem | Accountable owner role | Configuration / contract |
| --- | --- | --- |
| Contracts | Protocol maintainer | `src/core/schemas.js`, tool registry, protocol/version modules; Zod boundary validation |
| Browser engine | Browser maintainer | `src/browser/operations`; page expressions and capability implementations |
| Runtime | Runtime maintainer | `src/core`; sessions, approvals, retries, artifacts, replay |
| Native host | Host maintainer | `native-host/src`; framed messages, profiles, memory, provider execution |
| Adapters | Integration maintainer | `src/adapters`; protocol/schema translation and Promise SDK |
| Management | Installation maintainer | `src/management`; discovery, pure change plans, transactions, channels, restart handling |

Assign a named maintainer to each role before release ownership is finalized. Management must not import browser orchestration. Decision execution remains inside the native host. Pure transformations use ordinary TypeScript. Effect manages provider concurrency, cancellation, timeout, and typed failures; extend it to resource lifetimes and bounded runtime retries as those modules migrate. Public SDK methods remain Promise-based.

## Implemented migration foundation

- Checked TypeScript compilation and declaration output replace transpilation-only builds.
- Management and decision modules use strict TypeScript. Legacy JavaScript still compiles with `checkJs: false`; the final `allowJs: false` gate is not reached.
- Generated extension output is ignored and rebuilt for packaging.
- JSONC/TOML configuration planning, multi-file rollback, selected-client skill dry runs, explicit Jev routes, and channel snapshots have behavioral tests.
- Lint, unused-file/dependency checks, import-boundary checks, schema size limits, and a 500-line ceiling for new production modules run in CI.
- `architecture-exceptions.json` freezes existing large modules at their current line counts. Reducing an exception is preferred; increasing one requires an explicit reviewer explanation.

## Remaining release work

1. Complete responsibility extraction and strict conversion of legacy backend/background JavaScript; broaden lint and dependency-boundary coverage.
2. Integrate transactional native-host registration into setup, comprehensive duplicate ownership reporting, verification operations, and immutable ordinary installation snapshots.
3. Complete full-stack protocol handshake, narrowly scoped developer-extension reload, stable activation/launcher publication, and live multi-platform/client compatibility tests.
4. Separate mandatory local-model dependencies into the optional legacy package while preserving databases and exact/lexical recall. Start the 90-day retirement clock only when deprecation is publicly released.
5. Establish package/dependency/startup/browser-flow budgets from reproducible baselines. Current schema ceilings alone do not cover these.
6. Obtain the documented Luna API contract and preview access; measure complete browser flows before promoting providers from experimental.
7. Coordinate the history-rewrite cutover and inspect distributed release/npm artifacts separately.

Do not describe these remaining items as complete based on mocked tests or source compilation. Initial Jev results and their limits are in [the provider guide](DECISION-PROVIDERS.md).
