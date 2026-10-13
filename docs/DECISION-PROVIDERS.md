# Decision assistance

Cloud decision assistance is disabled by default. Select a service under **Settings → Decision assistance**, paste an API key, and use **Save & test connection**. The key input accepts the key itself; the optional Advanced field accepts an environment-variable name. Selecting and saving a service authorizes bounded search/replay intent and candidate descriptions. Executable actions are never sent. Luna screenshot sharing is separately opt-in; Jev remains text-only. Treat candidate text and your intent as potentially private.

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
