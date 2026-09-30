# Experimental decision assistance

Decision assistance is off by default. Jev can rank finite browser-target candidates when you explicitly enable text sharing. It receives the search query and candidate labels/text; it does not receive screenshots, credentials, form values, or executable actions. Treat page text as potentially private before enabling sharing.

For OpenRouter, make `OPENROUTER_API_KEY` available in the native host process environment, then run:

```sh
opencode-chromium providers configure --provider jev --route openrouter --share-text
opencode-chromium providers status
```

For TypeSafe directly, use `--route typesafe` and `TYPESAFE_API_KEY`. An explicit `--key-env NAME` overrides the credential reference. Preferences store the environment-variable name, never the key. The extension settings expose the same choices. Disable cloud calls with `providers configure --provider off`.

OpenRouter uses its [documented Decisions endpoint](https://openrouter.ai/blog/tutorials/how-to-use-jev/). Its evaluated build is pinned to `typesafe/jev-1.13-20260917`; TypeSafe direct uses `jev-1.13.0`. Requests never silently switch services. Timeouts, unavailable credentials, invalid IDs, and low confidence preserve deterministic fallback results. The agent remains responsible for action sequences, browser-state checks, and approvals.

OpenAI Decisions API / Luna remains unavailable until its official request contract and preview access can be verified. No alternative OpenAI model is substituted.

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
