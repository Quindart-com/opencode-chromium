# Experimental decision assistance

Jev is disabled by default. Select a service under **Settings → Jev decisions**, paste an API key, and use **Save & test connection**. The key input accepts the key itself; the optional Advanced field accepts an environment-variable name. Selecting and saving a service authorizes bounded search/replay intent and candidate descriptions. Screenshots and executable actions are never sent. Treat candidate text and your intent as potentially private.

OpenRouter's key check uses its documented `GET /api/v1/key`. A single small synthetic Decisions request then verifies access to the pinned Jev model; this test is billable. Settings and a replacement key are saved only after successful verification. Rejected credentials, insufficient credits, rate limits, and timeouts are shown with timings; tests never retry automatically. No browser data is used during connection tests.

Saved keys live in private native-host state. Windows encrypts them with the current user's DPAPI identity; macOS/Linux use an owner-only credential file and state directory. Keys are never stored in extension storage, returned in status, or logged. A saved service key takes precedence over its environment variable. Advanced settings can remove the saved key; disabling Jev preserves it for later use.

Overview reports local attempts, selected/abstained decisions, tests, response latency, and provider-reported tokens/cost from a bounded recent usage window. Missing usage or cost is shown as unreported, not treated as free. Harness tokens are separate. Usage records contain no query, page text, recipe, candidate ID, or credential.

For OpenRouter, make `OPENROUTER_API_KEY` available in the native host process environment, then run:

```sh
opencode-chromium providers configure --provider jev --route openrouter --share-text
opencode-chromium providers status
```

For TypeSafe directly, use `--route typesafe` and `TYPESAFE_API_KEY`. An explicit `--key-env NAME` overrides the environment fallback. Preferences store only the variable name; direct keys are stored separately. Disable cloud calls with `providers configure --provider off`.

OpenRouter uses its [documented Decisions endpoint](https://openrouter.ai/blog/tutorials/how-to-use-jev/). Its evaluated build is pinned to `typesafe/jev-1.13-20260917`; TypeSafe direct uses `jev-1.13.0`. Requests never silently switch services. Timeouts, unavailable credentials, invalid IDs, and low confidence preserve deterministic fallback results. The agent remains responsible for action sequences, browser-state checks, and approvals.

OpenAI Decisions API / Luna remains unavailable until its official request contract and preview access can be verified. No alternative OpenAI model is substituted.

### Search and replay limits

The local retrieval result is authoritative. A paid decision is consulted only when that result is genuinely ambiguous, and it can only reorder candidates the local pipeline already found. When the provider is unavailable, abstains, times out, or exceeds its burst budget, the local result is returned unchanged.

A decision is skipped when any of these holds:

- fewer than two candidates carry a node reference;
- the query is an exact phrase of exactly one candidate;
- the local pipeline embedded the query and the leading score is at least 0.18 ahead of the next one;
- an identical decision was already made for the same query, page fingerprint, and candidate set within 30 seconds;
- an identical decision is already in flight, in which case the two callers share one request;
- the burst budget is exhausted (six decisions, refilled one every three seconds).

Every skip is counted and shown in the popup's **Jev usage** panel as *Calls avoided*, so the saving is visible rather than assumed.

Page ranking uses up to 16 candidates with deduplicated descriptions of at most 160 characters, gathered from at most four label parts. The local pipeline is asked for a wider pool than the caller requested so a decision can promote a target it was shown; every return path trims back to the requested count, so enabling or disabling the provider never changes how many results the caller receives. A ranking request has a 1.5-second budget; connecting a key still uses the longer budget.

Exact recipe replay remains the first, free lookup. For an explicit `browser_run.memoryIntent`, Jev can select among at most 16 confirmed, failure-free saved recipes for the current profile, hostname, and requested step count. A single in-scope candidate is still a decision — replaying the wrong recipe costs more than the call. The host re-reads candidates after inference to reject superseded recipes. Confidence must be at least 0.95; ordinary per-step action/target checks, runtime-value binding, approvals, and mutation uncertainty handling still apply. Jev never generates an action sequence.

## Measured pipeline — October 5, 2026

Thirty synthetic UI units, twelve target-selection tasks (six exact labels, six paraphrases with no shared vocabulary), three rounds, driven through the real pipeline rather than the raw provider. Reproduce with `bun scripts/benchmark-decision-pipeline.ts <report.json>`; the fixture is in the script and no browser is involved.

| Measurement | Before | After |
| --- | --- | --- |
| Paid calls for 36 searches | 36 | 7 |
| Abstentions | 3 | 2 |
| Reported cost | $0.00092194 | $0.00018085 |
| Input / output tokens | 21,951 / 5,898 | 4,306 / 1,154 |
| Search latency p50 / p95 | 449.8 / 562.3 ms | 0.9 / 460.9 ms |
| Exact-label accuracy | 18/18 | 18/18 |
| Paraphrase accuracy | 15/18 | 15/18 |

A cold run with twelve distinct queries (`BENCHMARK_ROUNDS=1`) makes six paid calls instead of twelve, keeps 11/12 correct against the same baseline, and returns a median search in 6 ms.

Two caveats. Input tokens per paid call did not fall: 610 before and 615 after. The request's fixed scaffolding dominates the candidate descriptions, so fewer calls — not smaller calls — is the cost lever. And a wide margin between raw lexical scores is not a confidence signal: gating on it dropped paraphrase accuracy to 3/18 in testing, which is why the margin rule requires an embedding-backed ranking.

## End-to-end flow — October 5, 2026

The same build was driven through the real tool registry against a local fixture settings page: navigate, seven searches, two clicks, and a fill. Reproduce with `bun scripts/benchmark-agent-flow.js <report.json>`. The page is served on `127.0.0.1`; nothing leaves the machine except the decisions themselves.

| Measurement | Before | After |
| --- | --- | --- |
| Total wall time for eleven calls | 4,423 ms | 1,767 ms |
| Search wall time (seven searches) | 4,215 ms | 1,576 ms |
| Call latency p50 / max | 458.5 / 1,371.8 ms | 13.3 / 533.8 ms |
| Paid calls | 7 | 3 |
| Response characters | 6,959 | 6,981 |

## Initial live experiment — September 30, 2026

Twenty requests used four synthetic target-selection tasks, repeated five times, with seven fixed UI candidates. Requests used OpenRouter's `typesafe/jev-1.13` alias and returned `typesafe/jev-1.13-20260917`. There were no real page data, images, or browser mutations.

| Measurement | Result |
| --- | --- |
| Expected target selected | 18/20 |
| Abstentions | 2/20 |
| Lexical top result correct | 10/20 |
| First request | 1,522 ms |
| Remaining requests p50 / p95 | 535 / 1,720 ms |
| Lexical p50 / p95 | 0.51 / 1.07 ms |
| Reported input / output tokens | 8,940 / 1,520 |
| Reported total cost | $0.00037548 |

These small, repeated samples suggest improved synonym matching but do not establish faster browser flows or broad accuracy. The first request is a client-side cold measurement, not a controlled server cold start. Network time is included; model-only inference time was not exposed. Keep the provider experimental: latency is substantially above lexical search, and complete-flow success, approval correctness, and model-only timing still need measurement.

Reproduce with `bun scripts/benchmark-decisions.ts /private/path/report.json`. Supply the key through the process environment. Reports contain only synthetic tasks, decisions, timings, and available usage data. Do not commit credentials or private benchmark reports.
