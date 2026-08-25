# Action Memory

Action Memory is an opt-in, local, **vector-searchable record of agent browser
actions** that makes prior successful routes reusable across sessions and
self-corrects over time. It is off by default.

It records only structured signatures — never typed text, form values,
keystrokes, clipboard contents, URLs, window titles, paths, screenshots, or
accessibility trees — so the store contains **no personal content by
construction** and can be exported as plain JSON and shared.

## Enable or disable

```powershell
opencode-chromium memory enable     # opt in (off by default)
opencode-chromium memory status     # inspect state and success statistics
opencode-chromium memory pause      # pause capture, keep the store
opencode-chromium memory resume     # resume capture
opencode-chromium memory disable    # stop capture, keep the store
opencode-chromium memory delete --yes  # destroy the store (and its WAL)
```

`enable` initializes the SQLite store and verifies read/write before enabling
capture. Enabling does not start recording plaintext content — it starts
recording structured signatures.

## What is recorded

One **signature** per action, built from fixed fields:

- the capability enum (for example `browser.tab.create` or
  `browser.cdp.execute`);
- the target **hostname** when the extension reported it (`github.com`);
- the action verb derived from the capability;
- an optional **bounded element label** (at most 64 characters of the
  accessible name of the interacted element, passed explicitly by the agent at
  the action step — for example `Pay`); form values and typed text are never
  part of a signature.

Plus lifecycle metadata: confirmed/failed counts, first/last seen times,
opaque session id, and failure contexts (error code, step index, chain id,
count, last hit time).

The following are **never** stored: screenshots, typed text, keystrokes,
clipboard contents, raw tool arguments or results, file paths, window titles,
full URLs or URL paths, and accessibility trees.

## Success and failure semantics

- A **success** never duplicates a row: the matching signature's
  `confirmed_count` is incremented and its `last_seen` refreshed (the vector
  is "already there").
- A **failure** records the signature (or refreshes it) and upserts a
  `failure_context` keyed by signature + error code + step: repeated failures
  increment that context, forming a negative lesson.
- Search ranking is `cosine similarity × confidence`, where
  `confidence = (confirmed + 1) / (confirmed + failed + 1)`, ties broken by
  recency. Failures rank below confirmed routes and return with a
  `failed_count` badge.

## Chains

Consecutive steps of one `browser_run` (or any session slice) that carry a
chain id are stored as a **chain recipe**: ordered steps with their own
signatures, a composed embedding, source sessions, and merge lineage. A
`memory_search` for a task can return a whole chain whose steps map 1:1 into
`browser_run.steps`.

Chains evolve like Lego blocks:

- **append / overlap merge** — fragments from different sessions splice on
  shared step boundaries (`merged_of` records the parents);
- **correction** — when a chain step fails, the agent inspects, acts, and the
  confirmed corrective signature replaces the failed step in a new chain that
  **supersedes** the old one (`replaced_by` lineage, only the head is
  searchable, `supersedes`/`replaced_by` keep full history);
- executing a merged chain is itself the test: success reinforces it, failure
  triggers the next correction generation.

## Maintenance

Negative lessons are scored by `(1 + log2(1 + chain length)) × exp(−age /
(purge days × 0.5))` using the later of `occurred_at` and `last_hit_at` (last
time a search matched the lesson). Longer chains are worth more and are kept
longer.

- **Age-based purge** — negative lessons unused for longer than the purge
  period (default **7 days**) are removed; purely negative signatures that
  lose all contexts are removed too. Confirmed actions are **never
  auto-purged**.
- **Size-based eviction** — when the store crosses its quota (default
  **100 MB**), the lowest-value negative lessons are evicted until the store
  fits; if only confirmed actions remain and the store is still over quota,
  new captures pause and status reports `quota_reached`.
- **Power user mode** — `power_user` unlocks a quota slider from 256 MB up to
  **10 GB**. The database can get large in this mode.
- Manual: `opencode-chromium memory prune [--days N]`, `memory config set
  quota_bytes|purge_days|power_user`.

## Search

```powershell
opencode-chromium memory search "submit my order on the shopping site"
opencode-chromium memory search "checkout" --k 10 --kind chain
opencode-chromium memory search "stripe" --hostname checkout.stripe.com --json
```

The query is embedded locally (same model as page search: Snowflake Arctic
Embed XS by default, Qwen3 deep when configured) and never stored. Results
contain signatures, confidence, counts, hostname/capability/label, and chain
steps when applicable — never raw content.

## Agent access

When enabled (or forced via `OPENCODE_BROWSER_MEMORY=1`), the MCP server and
the OpenCode plugin register three read-only tools:

- `memory_status` — state, model, quota, purge settings, counts, success rate,
  and a `recent_daily` 14-day series for dashboards;
- `memory_query` — a bounded provenance slice with optional capability,
  hostname, session, and id filters;
- `memory_search` — top-k semantic retrieval of actions or chains.

Agents cannot enable, pause, delete, or change retention through these tools.
The bundled skill and MCP instructions ask the agent to consult memory only
for continue/resume/recall/recent-work requests, to treat results as evidence,
and to continue normally when memory is unavailable.

## Extension dashboard

The extension's popup links to the Action Memory options page in the browser
tab (Chrome extension settings → "Action Memory"):

- **Maintenance tab** — enable/pause/resume/disable, quota slider
  (power-user-gated), purge period, prune now, JSON export/import;
- **Dashboard tab** — the 14-day confirmed-versus-failed chart, success-rate
  badge, action/chain/negative-lesson counters, memory hits (times a search
  returned usable results), and quota usage.

## Configuration and storage

- Default store location (override with `OPENCODE_BROWSER_MEMORY_DIR`):
  - Windows: `%LOCALAPPDATA%\opencode-browser-plugin\action-memory`
  - macOS: `~/Library/Application Support/opencode-browser-plugin/action-memory`
  - Linux: `${XDG_STATE_HOME:-~/.local/state}/opencode-browser-plugin/action-memory`
- Storage is a SQLite database (`memory.db`, WAL mode) with float32 embedding
  columns; `bun:sqlite` or `node:sqlite` (Node ≥ 22.5) are probed at runtime.
- Embeddings are computed by the native host's local semantic worker; capture
  is non-blocking and degrades gracefully when the model is not yet loaded
  (`OPENCODE_BROWSER_MEMORY_EMBED=0` disables embedding entirely).
- Environment: `OPENCODE_BROWSER_MEMORY=0|1` forces tools on/off for a server
  process; `OPENCODE_BROWSER_MEMORY_DIR` relocates the store.

## Troubleshooting

| Condition | Behavior |
| --- | --- |
| `disabled` | Capture is off; earlier memory remains queryable and searchable. |
| `paused` | Only capture pauses; existing memory remains searchable. |
| `quota_reached` | New signatures are not captured until the quota is raised or memory is pruned/deleted. |
| `events_dropped` | The non-blocking write path dropped events; treat results as possibly incomplete. |
| Model unavailable | Signatures store without embeddings; search returns `memory_model_unavailable` until the model loads. |
| No SQLite runtime | Status reports `storage_unavailable`; upgrade to Node ≥ 22.5 or Bun ≥ 1.1. |

`memory export <file>` writes a shareable JSON snapshot (no embeddings, no
personal content); `memory import <file>` merges it by signature fingerprint.