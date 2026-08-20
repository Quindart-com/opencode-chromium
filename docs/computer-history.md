# Computer History

Computer History is an opt-in, encrypted, local record of agent-mediated
browser actions. It is **off by default** and records only bounded metadata so
a later agent run can answer: which site was acted on, which action
capability ran, and whether the outcome was confirmed. This reduces repeated
page exploration on continuation and recall requests without turning the
plugin into a screen recorder, keylogger, or telemetry collector.

## Enable or disable

```powershell
opencode-chromium history enable     # opt in (off by default)
opencode-chromium history status     # inspect state
opencode-chromium history pause      # pause capture, keep the store
opencode-chromium history resume     # resume capture
opencode-chromium history disable    # stop capture, keep the store
opencode-chromium history delete --yes  # destroy store and its local key
```

`history enable` initializes the encrypted store, creates a device-local key,
and verifies an authenticated write/read self-test before capture starts.
The CLI prints the stored-field allowlist and the deletion command.

Inspect events locally:

```powershell
opencode-chromium history list 50     # newest events
opencode-chromium history show 42     # one event by sequence
opencode-chromium history status --json
```

## What is recorded

Only fixed structured metadata:

- event type and timestamp, plus a monotonic per-store sequence;
- opaque session and action identifiers;
- one fixed capability enum (for example `browser.tab.create` or
  `browser.cdp.execute`);
- the action outcome and delivery categories (confirmed, failed, timeout);
- an optional application identity: the **hostname** of the page the action
  targeted (for example `github.com`) when the extension reported it;
- lifecycle events (enable, disable, pause, resume, session bound, access
  audit, writer health).

The following are **never** stored: screenshots, typed text, keystrokes,
clipboard contents, raw tool arguments or results, file paths, window titles,
full URLs or URL paths, and accessibility trees. There is no plaintext
fallback and no network I/O for history.

## Storage and encryption

- Default store locations (override with `OPENCODE_BROWSER_HISTORY_DIR`):
  - Windows: `%LOCALAPPDATA%\opencode-browser-plugin\computer-history`
  - macOS: `~/Library/Application Support/opencode-browser-plugin/computer-history`
  - Linux: `${XDG_STATE_HOME:-~/.local/state}/opencode-browser-plugin/computer-history`
- Records are AES-256-GCM encrypted before they reach disk: one random IV per
  record plus a per-chunk authenticated file header (no plaintext event data).
  The 32-byte root key lives in `<root>/key` with user-only permissions (`0600`),
  and each chunk derives its own key with HKDF-SHA-256.
- Default retention is 7 days and the default store quota is 100 MiB. Queries
  never return events older than the retention window; capture is
  non-blocking and never fails or slows the originating browser action.
- `delete` is cryptographic: it destroys the key file before removing the
  encrypted chunks. It does not claim physical erasure from backups, snapshots,
  or SSD wear leveling.

## Agent access

When enabled, the MCP server and the OpenCode plugin register two read-only
tools (they are absent when history is disabled):

- `history_status` — availability, encryption, retention, quota, byte usage,
  dropped-event count, and one fixed health category.
- `history_query` — a bounded metadata-only event slice (`limit` up to 200,
  optional `session_id`, `since_sequence`, `until_sequence`). A successful
  non-empty query appends an encrypted access-audit event.

Agents cannot enable, pause, delete, change retention, or obtain the key
through these tools. The bundled skill and MCP instructions ask the agent to
consult history only for continue/resume/recall requests, to treat events as
leads rather than a transcript, and to continue normally when history is
unavailable. Results always enter the current model context only.

## Troubleshooting

| Condition | Behavior |
| --- | --- |
| `disabled` | Capture is off; earlier encrypted history may remain queryable. |
| `paused` | Capture (and only capture) is paused; existing history remains. |
| `storage_corrupt` | A record failed authentication or schema validation; queries stop at that evidence instead of guessing. Use `history delete --yes` to start fresh. |
| `events_dropped` | The non-blocking capture path dropped events (full queue or quota); treat recent results as possibly incomplete. |
| `OPENCODE_BROWSER_HISTORY=0` | Forces history tools off even when enabled in the local state file. |
| `OPENCODE_BROWSER_HISTORY=1` | Forces history tools on for a server process without writing the local state. |