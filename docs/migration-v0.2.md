# OpenCode Browser v0.2 migration

v0.2.0 is a clean core API break. Core-v1 aliases are not advertised; the original 49-tool surface is available only with the explicit legacy toolset flag.

| Legacy pattern | v0.2 replacement |
| --- | --- |
| status, list profiles, select profile | `browser_session { action: "open", profile? }`, which returns tabs immediately |
| new tab, navigate, search, click | one `browser_run` chain |
| click, fixed wait, observe | one `browser_run` with `settle` and `postObserve` |
| page search / DOM inspect / visual map | `browser_observe` with `search`, `inspect`, or `visual` |
| `text` vs `value` action fields | one `value` field for ordinary action text |
| blind `wait` | conditional `settle`: `dom-quiet`, `exists`, `not-exists`, or `contains` |
| repeat an approved request | token-only `browser_run { approvalToken }` |
| screenshot base64 | artifact-first `browser_observe { mode: "screenshot" }` |
| explicit turn end | automatic after every `browser_run` |
| final cleanup | `browser_finalize` |

Step IDs eliminate extra round trips. A named `find` step can feed a later action through `{ "fromStep": "name", "index": 0 }`.

Search is lexical-first. `auto` uses the small Snowflake model only for uncertain matches and never blocks on a cold load or failed download. `deep` explicitly uses the retained Qwen embedding/reranker bundle.

Legacy mode is intentionally isolated. New integrations must build against the four-tool v0.2 surface.
