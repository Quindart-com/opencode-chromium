# Verified browser actions benchmark

The same seeded natural-language goals run through the real browser extension, native messaging host, and public MCP tools. A separate loopback connection checks the fixture server’s journal for the intended effect, its value, and extra effects. The deterministic driver chooses observed refs with a small goal grammar. It receives no fixture selectors, verification data, or expected outcome.

## Run locally

Use Node 24 or later, the repository’s installed development dependencies, and a built runtime. Build the extension for the engine you want to measure. The Chromium default uses the browser revision installed for the repository’s Playwright dependency. The Firefox extension requires Firefox 140 or later.

```sh
bun run build
bun run build:extension
node benchmarks/browser/run.mjs
```

The default runs ten actions in one disposable headless browser session. `--suite full` runs 30 cases per round, including a 500-row table, editable preferences, repeated ticket labels, a changing feed, a cross-origin checkout iframe, and controls in open shadow DOM. Two cases check abstention for a disabled or ambiguous control. Held-out cases vary the wording and the layout of neighboring controls. `--suite faults` deliberately clicks the wrong target, submits twice, injects a denied lookup, and drops confirmation after dispatch. A passing probe shows that the expected fault was detected. The contract test also injects a late effect on another client’s fixture and checks that its prior success is invalidated.

```sh
bun run build:extension:firefox
node benchmarks/browser/run.mjs --engine firefox --rounds 1
node benchmarks/browser/run.mjs --engine librewolf --executable /path/to/librewolf --rounds 1
node benchmarks/browser/run.mjs --suite faults --rounds 1
node --test tests/contracts/verified-actions-benchmark.test.js
```

`--engine waterfox --executable PATH` selects an explicit Gecko binary. `--headed` opens the disposable browser for a headed run. Windows creates and removes a uniquely named native-messaging registry entry for each profile. Running with a restricted account can fail at registration or browser launch. The harness reuses its own tab per session, and removes its temporary browser data after finalization. It uses the local fixture origins and starts without provider credentials, action memory, or installed-runtime repair.

Pass `--tokenizer /path/to/gpt-tokenizer` to use an existing `gpt-tokenizer@3.4.0` installation with `o200k_base`. The reports always include wire bytes. Token fields are `null` when an encoder is unavailable. To measure the managed product launcher in its disposable runtime directory, add `--managed`.

Pass `--observation targeted` to have the OpenCode driver include the entity ID already present in each goal in its first read. It checks the full page for matching lines, uses fresh refs and requires an exact, unambiguous label. The original viewport-first strategy remains the default. Use matching policies on both revisions to measure runtime changes, or run both policies on the same revision to measure the effect of the driver's choice. Reports and paired comparisons record the policy.

## Shared browser and comparators

```sh
node benchmarks/browser/run.mjs --suite load --rounds 1
node benchmarks/browser/run.mjs --suite load --matrix 1,2,4 --rounds 2 --seed load-v1
node benchmarks/browser/run.mjs --playwright-mcp /path/to/@playwright/mcp --rounds 1 --tokenizer /path/to/gpt-tokenizer
node benchmarks/browser/run.mjs --devtools-mcp /path/to/chrome-devtools-mcp --rounds 1 --tokenizer /path/to/gpt-tokenizer
node benchmarks/browser/run.mjs --playwright-mcp /path/to/@playwright/mcp --cdp-attach --rounds 1
```

The load matrix uses 1, 2, 4, 8 and 16 independent MCP subprocesses with one browser and one native connection per wave. Each client owns a tab and starts each trial at a barrier. Client 1 has a 300 ms delay on fixture navigation. Chromium runs a foreground-tab typing sentinel via an independent Playwright connection. The runner controls tab and document focus through the test browser. An OS keyboard or desktop-focus test requires a separate headed measurement. After the timed window, two clients race for one explicitly authorized synthetic tab when both discover it as eligible. A claim passes when exactly one client acquires it and the fixture remains untouched. Firefox can run shared sessions with the same effect verifier. Its foreground sentinel and claim race need an additional independent tab-control connection and are reported as untested.

Use existing installations of `@playwright/mcp@0.0.86` or `chrome-devtools-mcp@1.13.0`. The comparators run one Chromium client against the same fixture ledger. Use the same executable, viewport, seed, deadlines, tokenizer and harness checkout across arms. Playwright uses accessibility refs and starts isolated Chromium on its first navigation. Chrome DevTools opens its isolated browser and tab during setup, reads a fresh accessibility snapshot after each navigation, and acts using page IDs and snapshot UIDs. Its usage statistics and CrUX are disabled. Use session time for comparisons that include browser launch. [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Chrome DevTools MCP tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.13.0/docs/tool-reference.md)

`--cdp-attach` launches a disposable Chromium profile with a loopback endpoint and opens a fixture tab before a comparator connects. The comparator discovers that exact URL and reuses the tab. The independent driver checks that the original tab remains open on the last action’s URL after the MCP client disconnects and that neighboring tabs still have their original URLs. This mode exercises loopback CDP tab reuse. Playwright’s extension connection and Chrome’s interactive debugging approval need separate workflow checks. [Playwright connection modes](https://playwright.dev/mcp/configuration/browser-extension) · [Chrome DevTools MCP connection modes](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.13.0/docs/advanced-usage.md)

The product’s `auto` input mode distinguishes trusted pointer events from its background DOM clicks in the journal. `--input-mode pointer` makes a trusted click a condition of success.

## Reproduce and compare

`--project` can point at another checkout built with its own runtime and extension. For a clean source export without Git metadata, pass `--revision` with the full source commit. The runner checks the runtime source fingerprint against its build manifest and records the extension build hashes separately. A report identifies a supplied commit separately from a checkout HEAD.

```sh
node benchmarks/browser/run.mjs --project /path/to/base --seed pilot-v1 --rounds 1 --out reports/base-a
node benchmarks/browser/run.mjs --project /path/to/head --seed pilot-v1 --rounds 1 --out reports/head-a
node benchmarks/browser/compare.mjs reports/base-a reports/head-a
```

Alternate base-first and head-first runs on the same otherwise idle machine. `--round-offset` starts the deterministic schedule at a chosen round and can match the same round across separate processes. Use at least five matched trials per task for a release comparison. The comparison rejects mismatched workload identity or browser binaries and details lost successes and new forbidden effects. It reports when topologies differ and keeps paired latency observations and verified-only pairs visible. A single wave or a change smaller than repeat-to-repeat variation is inconclusive.

Run the evaluator against two clean, built worktrees to alternate five paired trials automatically. Every trial keeps the raw reports and a paired comparison. The combined comparison records all task outcomes, estimated tokens per verified action, and p95 for each trial. Existing baseline failures stay visible. A candidate failure or regression makes the command exit with status 1.

```sh
node benchmarks/browser/repeat.mjs --base /path/to/base --head /path/to/head \
  --out reports/paired-candidate -- --suite full --managed --seed pilot-v1 \
  --tokenizer /path/to/gpt-tokenizer
```

### Reports

The runner writes `results.jsonl` and `summary.json` to a new directory under `reports/verified-browser/` by default. JSONL contains run provenance, one wave row per client count, client lifecycle rows, and attempt rows. Each public request has a terminal record inside its client, attempt, or claim-race row. The records contain task and client identity, fixture hashes, start times, deadlines, returned error codes, wire sizes, and mutation acknowledgement. Raw MCP replies stay in memory. Startup or client failures still get planned attempt rows. The program exits with status 1 for unexpected failures and status 2 for invalid configuration or harness errors. Reports are available for unsuccessful trials that reached a wave.

- Action time starts at barrier release, includes fixture navigation, discovery, dispatch, follow-up and independent verification, and ends at verification or the attempt deadline. Full session time includes browser setup, the schema handshake, finalization, and the final journal check. A later extra effect can invalidate a provisional result. An effect first seen after the deadline is recorded and fails the timed attempt.
- Action costs include every attempted task call, including timeouts, extra reads, and fetched tool artifacts. Session costs also include client setup and finalization, schema and initialization, and claim-race calls when run. Tokens per verified action divides all measured tokens in that scope by verified actions. Zero verified actions yields `null`. Guards and injected faults are reported separately from ordinary successes. Request token counts encode MCP parameters and returned token counts encode MCP text blocks or explicitly fetched resources. These estimate context cost without an LLM, prompt caching, or image-token accounting.
- Per-phase times describe public calls. A paired `browser_run` can contain action, settling and post-observation in the same duration. Server-internal queue and settling times are unavailable until the runtime exposes them. The runner records its own barrier wait. The host samples are operating-system measurements for the registered native host process at wave boundaries. They omit its child processes. Missing samples are `null`.
- The fixture counts every annotated action, draft edit, committed value, and repeat navigation. The verifier checks the expected row and its neighbors, records input trust and rejects unexpected input on another tab. No uncertain mutation is sent again. The final check detects late effects within the fixture’s observable lifetime.

This harness measures deterministic goal execution and disposable connection, viewport, finalization, and race behavior. It leaves real-agent model usage, interactive approvals, uploads and native dialogs, signed-in profile continuity, hands-on CLI setup, tab release and handoff, extension reload, and browser restart for separate workflow checks. The browser-version fields and ledger viewport measurements identify which results can be compared. Keep raw local reports under the ignored `reports/` directory.
