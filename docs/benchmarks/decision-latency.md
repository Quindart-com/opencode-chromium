# Decision latency investigation

Measured on 2026-10-29 with synthetic UI labels and images. Existing service keys
were reused without changing the active service, consent settings or credentials.
No browser content was submitted. This is a small diagnostic sample, not a model
speed or accuracy guarantee.

## Integration findings

With screenshot consent enabled, Luna previously captured immediately for every
ambiguous search. Jev tried text first. Luna also skipped the early text-result
cache, so repeated searches could capture even when no additional image request
was permitted by the quota.

Both providers now try text first. Only a valid low-confidence answer may trigger
image fallback. Confident text results use the existing document/candidate cache;
image results still require matching fresh pixels. Authentication, transport and
deadline failures never trigger screenshots. Consent and image quotas remain in
force. The total search decision budget remains 1.5 seconds, including capture
and fallback; standalone image requests retain their separate five-second cap.

A controlled component benchmark used 20 ms text, 200 ms image and 100 ms capture
delays. Three identical ambiguous searches produced:

| Path | Before, ms | After, ms | Before captures | After captures |
| --- | --- | --- | ---: | ---: |
| Luna with image consent | 349, 111, 115 | 60, 1, 1 | 3 | 0 |
| Jev with image consent | 34, 1, 1 | 37, 1, 1 | 0 | 0 |

These are isolated component timings with mocked network/capture delays. They
demonstrate removed work and cache reuse, not a production browser speedup claim.
The regression suite covers both direct OpenAI and OpenRouter Luna, including
fresh-pixel invalidation, consent changes, errors and exhausted image quotas.

## Local connection finding

The Node runtime's default 250 ms address-family attempt timeout abandoned usable
addresses on this network. A parallel TLS probe with normal certificate checks
showed both OpenAI and OpenRouter timing out at six seconds after three address
timeouts. Allowing 1,000 ms per attempt connected in 846 ms and 1,119 ms.

The standalone native host now raises a shorter attempt timeout to one second.
Longer user-configured values remain intact. Both address families remain enabled;
DNS, TLS verification, OS networking and parent harness processes are unchanged.
The overall request deadlines still bound the complete operation.

See [Node's address-family connection options](https://nodejs.org/api/net.html#socketconnectoptions-connectlistener).

## Live service comparison

The same six candidate labels and four paraphrased intents were sent sequentially
in alternating provider order, with a five-second diagnostic cap. The native-host
connection policy above was applied. Values use nearest-rank p50; first-connection
cost is included. Responses that abstained are included in timings.

| Service/model | Text requests | p50, ms | Maximum, ms |
| --- | ---: | ---: | ---: |
| OpenAI Platform / gpt-6-luna | 4 | 637 | 2,931 |
| OpenRouter / Jev 1.13 | 4 | 476 | 1,457 |
| OpenRouter / Luna Decisions | 2 | 596 | 616 |

A separate valid 320 by 320 synthetic image check had two calls per model:
OpenAI Luna p50 593 ms, maximum 1,560 ms; OpenRouter Jev 1.14 p50 572 ms, maximum
1,551 ms. Earlier undersized Jev image fixtures were rejected locally and are
excluded. No conclusion about general visual quality follows from these examples.

The application uses the native [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions),
not a generated chat response. The samples show some service and cold-connection
variation, while the larger avoidable delay came from transport failures and the
different screenshot/cache paths. Private raw reports remain outside Git.
