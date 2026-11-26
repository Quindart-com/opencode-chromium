# Anonymous diagnostics

Anonymous diagnostics help prioritize unreliable tools, slow operations, browser regressions, and runtime exits. The preference is **on by default** for new and existing installations. Turn it off in **extension Settings → Anonymous diagnostics**. The preference applies to all browser profiles and agent clients using the same managed runtime directory, survives updates, and takes effect without restarting. Firefox additionally respects its built-in optional technical-data permission; denying or revoking it prevents transmission.

Set `OPENCODE_BROWSER_TELEMETRY=0` or `DO_NOT_TRACK=1` in the native host environment to enforce an opt-out. A disabled setting is never overwritten by a default during upgrades. Unreadable or malformed preferences disable collection. Disabling discards pending counters and cancels in-flight uploads where possible; data already received cannot be recalled. Re-enabling starts fresh counters.

## What is sent

The native host batches counters in memory, normally once every five minutes and on graceful shutdown. Each entry contains a count and these bounded dimensions:

| Field | Values / purpose |
| --- | --- |
| `tool` | The four browser tools, three memory tools, or runtime health |
| `operation` | A fixed observation mode or session action |
| `outcome` | Success, partial, failure, timeout, approval required, authorization required, or unclean exit |
| `error_code` | An allowlisted code; every unrecognized value becomes `OTHER` |
| `failure_stage` | When available, the profile, action, settle, observe, cleanup, or adapter stage |
| `duration_bucket` | Under 100 ms, 500 ms, 2 s, 10 s, 30 s, or at least 30 s |
| `retry_count` | Actual automatic read-operation retries, capped at 20 per tool call |
| `recovery`, `replay` | Bounded recovery / action-memory outcome categories |
| `release` | The plugin version |
| `browser_family`, `browser_major`, `os_family` | Coarse runtime environment |

No browsed URLs or domains, page text, page titles, screenshots, DOM, clipboard contents, form values, selectors, search queries, credentials, profile names or IDs, session IDs, account IDs, paths, raw error messages, stacks, or tool arguments are included. Records use a strict allowlist schema in the native host. Unknown fields are rejected rather than forwarded. There is no session replay, autocapture, persistent analytics ID, fingerprint, or background browsing monitor.

Only native-host processes leave local running markers containing the release, coarse browser family/major and a local preference generation. A later host may count a dead process once as an **unclean exit**. This is a possible crash, forced termination, or shutdown; it is not a confirmed browser crash. Live concurrent hosts are ignored. Local PIDs and generation tokens never leave the machine. Tool errors before a host can be selected cannot always be reported.

## Delivery

When a release has a configured collector, the native host sends aggregated counters through a Quindart endpoint to Google Analytics 4 for reliability reporting. Without a configured collector, the diagnostics summary is local. Each batch uses a fresh random analytics client identifier. The collector excludes source IPs and browser user-agent strings from forwarded diagnostics and denies advertising consent. Network services receive normal connection metadata.

Uploads have a 1.5-second timeout, no redirects, no cookies and no retry backlog. The queue is limited to 250 distinct counter combinations, with at most 25 combinations per request. Data is intentionally lossy on shutdown, network failure or overflow. Tool execution does not wait for telemetry and retains its original result/error. The preference is checked before recording and uploading, including across concurrent host processes. Firefox permission is checked again before every upload.

## Reports to prioritize

- Failure rate = failed, partial and timed-out **occurrences** divided by completed success, failed, partial and timed-out occurrences. Exclude approval/authorization pauses from failures.
- Break down by release, browser family/major, tool and operation.
- Rank error codes by occurrences and compare latency buckets across releases.
- Track retry/replay/recovery categories and unclean exits separately.

### Local diagnostics summary

Run `opencode-chromium diagnostics summary` for local call counts by release, browser, adapter, tool, outcome, and failure stage. The JSON includes first and last seen times, total elapsed and stage times, request and response JSON byte counts, retries, and how often mutation dispatch was acknowledged or uncertain. An acknowledgement records what the browser runtime reported. Verification of the effect belongs to the caller or benchmark fixture.

The local summary can include profile selection failures even when the call never reached a browser host. Approval requests, declined uploads, and an invalid or expired approval token have their own categories and are excluded from the failure-rate denominator. Byte counts measure the tool's JSON. Model provider usage is measured by the benchmark.

The journal uses the same diagnostics preference and environment opt-outs. It keeps up to seven days of bounded, best-effort records on this machine and reports the current preference generation. Busy queues, closed processes, and failed writes can leave gaps. Exact times and byte counts stay local, and records contain only the allowlisted fields even when the upload endpoint is unconfigured.

These metrics measure participating traffic. Opt-outs and dropped batches mean they cannot establish total installations, unique people, or complete crash counts.

Before release, update Chrome Web Store privacy-practice disclosures and the Firefox listing to match this policy. Collection is for product reliability; it is not used for advertising.
