# Browser reliability overhaul

This is a staged repair and migration. The draft pull request contains the first implementation, not a claim that every runtime module is already type safe or that the extension has been released.

## Implemented and covered by regressions

- Replace the Bun-only SQLite transaction helper with SQL transactions that work under both Node and Bun. Clear stale embedding errors after a successful write.
- Read shared capture settings across live database connections. Persist action counters and profile attribution atomically. Apply quotas and cleanup to v2 capture.
- Track profile provenance separately from shared action recipes. Filter execution history by current, selected, or all profiles; deduplicate shared actions. Leave old history unassigned.
- Preserve live action parameters during replay; stop after an uncertain mutation rather than dispatching it again. Preserve target roles, use the live tab hostname, and honor post-observation on replay.
- Restrict persisted selectors to structural attributes, excluding input values and arbitrary attributes.
- Compile maintained backend sources to JavaScript. Keep the installed host entry point compatible. Add strict TypeScript modules for profile statistics, database boundaries, frame decoding, and embedding validation/concurrency.
- Use an Effect service to serialize embedding batches, validate their dimensions, and interrupt queue work at shutdown. Coalesce duplicate queued work and recover a bounded set of unindexed rows when the store opens.
- Show profile-scoped statistics, explicit errors and refresh times, connected-profile selection, and optional renaming. Keep model tuning under Advanced and preserve unsaved inputs during polling.
- Stop reporting refused store uploads as successful. Optionally inspect API v2 release state with `CHROME_PUBLISHER_ID`; distinguish existing published versions from outstanding submissions. Preserve release ZIP artifacts for inspection and retries.
- Correct the README SDK import and collapse client-specific setup instructions.

## Remaining migration and reliability work

1. Migrate the core action dispatcher, browser operations, RPC relay, semantic worker, and extension background to strict TypeScript in dependency order. Keep Promise-based public APIs and Zod schemas. Generate and verify public SDK declarations; do not substitute unchecked casts or file renames for migration.
2. Move host resources and long-running worker lifecycle into scoped Effect services. Add durable indexing leases across processes, bounded automatic recovery beyond one queue capacity, cancellation of actual model work, and durable retry state. Current shutdown cancellation prevents late queue writes but cannot terminate an embedder that ignores its signal.
3. Add retained aggregate metrics and bounded event retention. Improve quota eviction and disk reclamation, and verify restoration of migration snapshots under simultaneous hosts. Current profile association tables are additive schema version 3.
4. Replace simulated efficiency benchmarks with isolated extension/native-host/browser fixture runs that measure real dispatches, errors, and repeated-task savings. The popup check uses a real browser and SQLite with a fixture bridge; it does not prove native-messaging installation or real model quality.
5. Finish decomposing large modules after behavior coverage is in place. Remove dead paths only after checking imports, public exports, and packaged entry points. Review target re-resolution, frame routing, cancellation, and model-switch races with fault injection.
6. Verify the packed npm artifact under supported runtimes and complete native-messaging tests with two isolated browser profiles. Node 20 supports the compiled application but does not provide the embedded SQLite needed for action memory; memory requires a supported Node SQLite runtime or Bun.

## Review and release gates

PR checks build both artifacts, run strict checks for migrated modules and the extension, run Node/Bun regression tests, inspect package contents and schema budgets, scan public hygiene, and exercise the popup against isolated data. Existing JavaScript is still unchecked by the backend TypeScript configuration.

Before a release, require the complete migration and browser verification evidence described above. Keep the pull request unmerged while those items remain. Store submission is separate from approval: a pending item must be resolved before another upload, and a submitted build must not be described as published. No version bump or release is part of this repair checkpoint.
