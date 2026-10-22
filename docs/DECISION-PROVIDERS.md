# Decision assistance

Cloud decision assistance is disabled by default. Select a service under **Settings → Decision assistance**, paste an API key, and use **Save & test connection**. The key input accepts the key itself; the optional Advanced field accepts an environment-variable name. Selecting and saving a service authorizes bounded search/replay intent and candidate descriptions. Executable actions are never sent. Screenshot sharing is separately opt-in for Jev and Luna. Treat candidate text and your intent as potentially private.

**Save & test connection** makes one small, billable request to the selected model using synthetic data. Settings and a replacement key are saved only after successful verification. Rejected credentials, insufficient credits, rate limits, and timeouts appear in the panel; tests never retry automatically. No browser data is used during connection tests.

Saved keys live in private native-host state. Windows encrypts them with the current user's DPAPI identity; macOS/Linux use an owner-only credential file and state directory. Keys are never stored in extension storage, returned in status, or logged. A saved service key takes precedence over its environment variable. Advanced settings can remove the saved key; disabling Jev preserves it for later use.

Overview reports local attempts, selected/abstained decisions, tests, response latency, and provider-reported tokens/cost from a bounded recent usage window. Missing usage or cost is shown as unreported, not treated as free. Harness tokens are separate. Usage records contain no query, page text, recipe, candidate ID, or credential.

For OpenRouter, make `OPENROUTER_API_KEY` available in the native host process environment, then run:

```sh
opencode-chromium providers configure --provider jev --route openrouter --share-text
opencode-chromium providers status
```

For TypeSafe directly, use `--route typesafe` and `TYPESAFE_API_KEY`. An explicit `--key-env NAME` overrides the environment fallback. Preferences store only the variable name; direct keys are stored separately. Disable cloud calls with `providers configure --provider off`.

OpenRouter uses its [documented Decisions endpoint](https://openrouter.ai/blog/tutorials/how-to-use-jev/). Its evaluated build is pinned to `typesafe/jev-1.13-20260917`; TypeSafe direct uses `jev-1.13.0`. Requests never silently switch services. Timeouts, unavailable credentials, invalid IDs, and low confidence preserve deterministic fallback results. The agent remains responsible for action sequences, browser-state checks, and approvals.

OpenAI Luna is available through OpenRouter with model `openai/gpt-6-luna-decisions` and the same Decisions endpoint. Select **OpenAI Luna through OpenRouter** and save/test your connection. Existing provider choices stay unchanged on upgrade. CLI: `opencode-chromium providers configure --provider openai-decisions --route openrouter --share-text`.

Enable screenshot sharing separately in Settings or with `--share-images`. For an ambiguous page decision, at most one JPEG screenshot of the controlled tab is shared, bounded to 300 KB before base64 encoding. Capture and inference share the 1.5-second budget. Exact named matches never capture an image. Coalescing includes provider, model, page state, and tab identity; visual cache entries also include image identity. Revoking consent prevents sending new images. Validated candidate IDs and probabilities can only reorder existing targets; normal live checks and approvals remain authoritative.

Requests follow the [multimodal state contract](https://openrouter.ai/docs/guides/community/multimodal-decisions): text plus a base64 `image_url` part with low detail. [Luna documentation](https://openrouter.ai/openai/gpt-6-luna-decisions). Images may contain private page content.

Decision assistance only ranks targets already found locally. Exact matches stay local; timeouts, low confidence and unavailable services preserve local results. See the README benchmark for measured results and limits.

## Jev image fallback (experimental)

Enable **Allow experimental image fallback** under either Jev service, then save. CLI users can add `--share-images` to their existing Jev configuration. Upgrades keep image sharing off unless you enable it. Connection testing still sends only synthetic text.

Local matches run first, then the existing Jev 1.13 text model. Only a valid low-confidence text decision can escalate to Jev 1.14 (`jev-1.14.0` directly or `typesafe/jev-1.14` through OpenRouter). Credential, credit, rate, malformed-response and timeout failures never trigger an image request. Capture and both decisions share one 1.5-second deadline. A cold or slow text request can use that deadline before images are considered.

The fallback sends one JPEG from the controlled tab, normally around 110,000 pixels, preserving aspect ratio. Each side stays between 280 and 768 pixels; extreme aspect ratios are skipped. The compressed file is capped at 200 KB. Candidate rectangles use normalized viewport coordinates so resizing preserves their positions. This helps distinguish controls with identical labels or visual differences. Jev selects a known candidate ID; ordinary live-target checks and approvals still govern actions. The experimental Box API is not used for unrestricted coordinate clicks.

Direct TypeSafe requests use one UUID-referenced asset and the `TypeSafe-Danger-Zone-Images` header. OpenRouter requests use an inline image part instead. See [TypeSafe images](https://docs.typesafe.ai/images) and [OpenRouter's media contract](https://openrouter.ai/docs/guides/community/multimodal-decisions).

All decision images, including Luna, share a persistent allowance of **one request per UTC minute and 20 per UTC day** across local profiles and host processes. Attempts consume reservations even if cancelled or rejected. Successful visual results are reused only after fresh pixels match the cache; uncertain text results are briefly cached to avoid repeated text charges. Provider settings, model, tab, page state and image identity separate cached decisions. There are no automatic provider retries. Revoking screenshot consent prevents new image sends, including queued calls.

### Cost and measured limits

As of October 22, 2026, Jev 1.14 costs **$0.042 per million input tokens**, with free output. Images count toward input tokens without a separate image fee. TypeSafe has not published a formula for image token counts; JPEG bytes are not a token estimate. Read actual `usage.input_tokens` and reported cost. [TypeSafe pricing](https://docs.typesafe.ai/models), [image accounting](https://docs.typesafe.ai/images#image-tokens), [OpenRouter pricing](https://openrouter.ai/typesafe/jev-1.14).

One synthetic two-button fixture through OpenRouter on October 22 produced:

| Jev 1.14 input | Reported input tokens | Reported cost | Response time | Result |
| --- | ---: | ---: | ---: | --- |
| Text | 415 | $0.000017430 | 1,509 ms | Abstained |
| Text + 768×576 JPEG | 1,631 | $0.000068502 | 592 ms | Correct target |
| Text + 384×288 JPEG | 763 | $0.000032046 | 607 ms | Correct target |

These are single requests using a 5-second measurement timeout, not a benchmark or a latency guarantee. The runtime retains its 1.5-second total budget. Token differences include image and request-structure overhead. At the measured smaller size, 1,000 text-plus-image fallback pairs would cost about $0.0495 at the current rate; other pages can differ. Request caps bound frequency, not dollar spending. Set an upstream API-key spending limit for a financial cap; cancelled requests may still be billed.

The synthetic probe defaults to offline checks. To reproduce it, build its Node runner with `bun build scripts/verify-jev-images.ts --target=node --packages=external --outfile=reports/verify-jev-images.mjs`, then run `node reports/verify-jev-images.mjs`. Add `--cloud` for exactly three billable requests using an existing credential. It opens its own headless browser and leaves saved provider settings unchanged.
