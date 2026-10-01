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

Page ranking uses up to 16 lexical candidates with deduplicated descriptions of at most 400 characters. A single candidate needs no paid decision. Exact recipe replay remains the first, free lookup. For an explicit `browser_run.memoryIntent`, Jev can select among at most 16 confirmed, failure-free saved recipes for the current profile, hostname, and requested step count. The host re-reads candidates after inference to reject superseded recipes. Confidence must be at least 0.95; ordinary per-step action/target checks, runtime-value binding, approvals, and mutation uncertainty handling still apply. Jev never generates an action sequence.

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
