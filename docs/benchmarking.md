# Benchmarks

How fast and how accurately the plugin finds and acts on the right element of a page, measured on small synthetic fixtures.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/benchmarks/summary-dark.svg">
  <img src="../assets/benchmarks/summary.svg" alt="Benchmark summary: exact labels 6 of 6 and paraphrases 1 of 6 in-process; 12 of 12 and 0 of 6 through the full browser pipeline" width="100%">
</picture>

## Latest results

**Version 2.0.5 · measured November 23, 2026** on Windows with Bun and Node 22. No cloud requests were made.

### Target selection (in-process)

The local ranker picks one control for each of 12 queries on a 30-control settings page. Raw data: [`accuracy.json`](../assets/benchmarks/accuracy.json).

| Query type | Correct top result | Median time |
| --- | ---: | ---: |
| Exact label, such as "save changes" | **6 / 6** | 0.51 ms |
| Paraphrase, such as "make the page easier on the eyes at night" | **1 / 6** | 0.40 ms |
| Correct answer among the top 16 candidates | **11 / 12** | — |

### Full browser pipeline

A disposable Chromium with the extension, native host and SDK searches the page, clicks the top result and checks the page state. There are 6 tasks and 3 rounds. Raw data: [`pipeline.json`](../assets/benchmarks/pipeline.json).

| Task type | Found, clicked and verified | Median time per task |
| --- | ---: | ---: |
| Exact or near-exact label | **12 / 12** | 600 ms |
| Paraphrase ("stop notifications" → *Mute alerts*) | **0 / 6** | 600 ms |

Each task takes two tool calls (`browser_observe` and `browser_run`) and returns about 2.8 KB.

### Lexical search throughput

150 searches over 500 synthetic controls in one process, median of 3 runs:

| p50 | p95 | Result hash |
| ---: | ---: | --- |
| 2.4 ms | 4.3 ms | `bbd246fd…3671d` (unchanged means identical rankings) |

### What this means

- **Exact labels are reliable and cheap.** Local search finds them in under a millisecond, with no model.
- **Paraphrases need help.** Local lexical search rarely matches a request that shares no words with the label. The correct target is still in the candidate pool 11 times out of 12, so an optional [decision provider](DECISION-PROVIDERS.md) can rerank it. Run `--cloud` to measure that.
- **Most pipeline time is spent in the browser, not in ranking.** Ranking takes under 1 ms of the roughly 600 ms per search-and-click task.

## Benchmark suite

| Command | What it measures | Needs | Cost |
| --- | --- | --- | --- |
| `bun run benchmark:accuracy` | Top-1 target accuracy and latency of the local ranker on the fixed 12-query fixture | Nothing | Free |
| `bun run benchmark:accuracy -- --cloud` | The same fixture with Jev text, Luna text and Luna image decisions in isolated temporary settings | An OpenRouter key | ≤ 18 paid requests |
| `bun run benchmark:lexical` | Ranking speed, CPU and a result hash over 500 controls | Nothing | Free |
| `bun run benchmark:production` | Search, click and verification through a real extension, native host and SDK | A build and Playwright Chromium | Free |
| `bun run benchmark:heldout` | Extraction, local ranking and clicks on a separate fixture; can compare another ranker build | A connected browser | Free |
| `bun run benchmark:flow` | Latency of a fixed tool sequence, with final-state checks | A connected browser | Free |
| `bun run benchmark:decisions` | Calls, tokens and cost of the decision pipeline as a real search would incur them | A configured provider | Paid |
| `bun run benchmark:decisions:capped` | Direct Jev compared with Luna text decisions, under a hard $5 limit | An OpenRouter key | Paid, capped |
| `node scripts/benchmark-memory-threshold.js` | Similarity threshold for action-memory recall on the calibration pairs | Nothing | Free |

Recorded result: threshold 0.63 with 0.67 recall and no false positives on 6 positive and 6 negative pairs.

## Running them

### Local, no browser

```sh
bun run benchmark:accuracy          # writes reports/benchmark-accuracy.json
bun run benchmark:lexical
node scripts/benchmark-memory-threshold.js
```

### Real browser

```sh
bun run build && bun run build:extension
npx playwright install chromium     # once
bun run benchmark:production reports/production.json 3    # report path, rounds 1–10
```

`benchmark:production` runs under Node on purpose: on Windows, starting the Playwright fixture under Bun can stall. It uses a temporary profile and a uniquely named native host, so it never touches your installed browser, host or provider settings.

`benchmark:heldout -- --out reports/heldout.json --rounds 2 [--ranker PATH]` and `benchmark:flow` use the browser your runtime is already connected to. To compare two revisions, build each checkout separately and run the same command under similar conditions.

### Cloud decision models (paid)

```sh
bun run benchmark:accuracy -- --cloud
bun run benchmark:decisions:capped -- reports/decision-run.json   # path must not exist yet
```

- `--cloud` reuses your saved OpenRouter key in a temporary provider directory. It makes at most 18 requests and does not change your saved provider choice.
- `decisions:capped` checks current catalog prices and reserves $0.20 of a $5 budget before each request. It stops if a response omits usage or cost. Aborted requests stay reserved, because they may still be billed.

## Updating the published results

```sh
bun run benchmark:accuracy
bun run build && bun run build:extension
bun run benchmark:production reports/production.json 3
cp reports/benchmark-accuracy.json assets/benchmarks/accuracy.json
cp reports/production.json assets/benchmarks/pipeline.json
bun run benchmark:chart             # redraws summary.svg and summary-dark.svg
```

Then update the tables and the date at the top of this page. Each report records the package version, time, fixture hash and source fingerprints, so its numbers can be traced to the code that produced them.

## Limits

- **Small, synthetic fixtures.** 12 queries and 6 tasks cannot establish general accuracy. These numbers are not WebVoyager scores, full agent task success rates or comparisons with other browser agents.
- **No agent planning.** Every benchmark issues fixed queries; none measures how a model chooses what to do next.
- **Noisy timings.** Single rounds, browser scheduling and the first network connection all add variance. Compare revisions on the same machine and check the result hash.
- **Decision models only rerank.** A target missing from the local candidate pool cannot be recovered, even with a screenshot.
- **Cost may be incomplete.** Providers do not always report usage, and cancelled requests can still be charged.

Committed reports must contain synthetic labels only. Never commit credentials, browser profile IDs, real page content or local paths; keep private raw reports in the ignored `reports/` folder.

## Past investigations

- [Decision latency, October 2026 (v1.10.x)](benchmarks/decision-latency.md): text-first screenshot fallback, the Node connection-timeout fix and live provider timings.
