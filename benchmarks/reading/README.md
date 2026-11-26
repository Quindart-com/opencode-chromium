# Browser routing baseline

This suite records what the current extension can do before changing its tool schemas, observation defaults, memory or hosted routing. All new cases use a disposable Chromium profile and loopback fixture pages. The separate registry admission test intercepts HTTPS before transport. The earlier live Hacker News and Jev results remain in their own report.

## Repeat the measurement

Build the target worktree and extension, use Node 24, and supply the same Chromium binary and local `gpt-tokenizer@3.4.0` package as the baseline. The reports identify the browser and build by digest. On Windows the fixture needs permission to create and remove its own temporary native-messaging registration. Run the arms sequentially on the same machine. Use a new output directory for each run.

```sh
node benchmarks/browser/run.mjs --suite full --managed --rounds 5 --seed routing-baseline-v1 --observation viewport --tokenizer "<tokenizer dir>" --executable "<chromium>" --out reports/my-run/viewport
node benchmarks/browser/run.mjs --suite full --managed --rounds 5 --seed routing-baseline-v1 --observation targeted --tokenizer "<tokenizer dir>" --executable "<chromium>" --out reports/my-run/targeted
node benchmarks/reading/run.mjs --probe --tokenizer "<tokenizer dir>" --executable "<chromium>" --out reports/my-run/probe
node benchmarks/reading/run.mjs --operator "<model and effort>" --operator-mode autonomous --tokenizer "<tokenizer dir>" --executable "<chromium>" --out reports/my-run/agent
node benchmarks/reading/registry.mjs reports/my-run/registry.json
node benchmarks/reading/summarize.mjs reports/my-run
```

For an implementation comparison, keep the harness fixed and point both browser runners' `--project` at each built checkout. Run the offline registry benchmark from the checkout being evaluated. Run the original and candidate in alternating order for latency comparisons. Use `node benchmarks/browser/compare.mjs <before>/<policy> <after>/<policy>` for paired verification and timing. A fixed seed matches resource IDs and layout across arms. Use additional unpublished seeds and an independent operator to test generalization.

The summary records independent operators, parent-relayed decisions, fixed workflows, replays, and fixture-author runs separately. An empty category means unmeasured. Pass the category as the optional fourth argument to the release comparison to check operator and fixture compatibility.

## How to score it

- **Verified actions.** Each observation policy gets five rounds of the same 30 goals on six apps. A deterministic controller sees goals and public MCP replies. An independent fixture journal checks the affected record, field and value, rejects extra effects, and checks guard cases separately. Headline time includes navigation and verification. Costs include failed attempts and guards in the numerator and divide by verified actions. Session initialization and schema are reported separately. See `benchmarks/browser/README.md`.
- **First observation.** On each pre-opened read fixture, call plain `browser_observe` in read mode once. Count how many of the eight numeric tasks expose the expected number in the first MCP text response. The two abstention cases have no numeric answer. Presence of a number measures evidence availability only.
- **Agent choices.** Give the operator each printed goal, ordinary tool definitions and replies. Never consult fixture source, expected answers or saved results during the trial. The controller sets up each tab and accepts newline-delimited JSON such as `{"tool":"browser_observe","args":{"mode":"read"}}`, `{"tool":"resource","args":{"uri":"<returned URI>"}}` and `{"answer":"<value or requested abstention>"}`. Open returned image attachments when needed. Score exact answer and source using an independent oracle. A published value requires the live fixture page, a canvas answer requires an image, and a displayed value must come from the original document. The repeated layout has fresh numbers. No correctness feedback is printed between tasks. Each task allows eight MCP calls.
- **Agent costs.** Tool wall time sums timed MCP calls per task. Browser setup, fixture navigation, operator deliberation and harness I/O are excluded and should not be compared to the navigation-inclusive action latency. Text tokens use `o200k_base` for request arguments and MCP text. Image blocks are counted separately. These are context estimates and exclude inference, repeated conversation history and image tokens.
- **Registry accuracy.** Ten predeclared decisions exercise the actual site operation with a controlled synthetic tab and profile grant. Score eligible requests on the dispatched item and fields. For invalid requests, require a domain-specific refusal before dispatch. The network boundary captures the payload locally. This measures admission, not hosted latency or upstream data freshness.

Frozen summary metrics are in `baseline-v1.json`. The per-attempt evidence archive is kept outside the repository. The measured product revision is `893a911`. The rebuilt runtime's bundle digest matched its earlier build.

Before enabling an automatic route, compare verified actions, correct answers, wrong resource/source and wrong/extra effects first. Then compare text tokens, calls, and latency on matched tasks. The ten-read agent trial used the fixture-author session. Independent operators, a new site, and a contribution received on a fresh installation are separate tests for generalization and cross-install value.
