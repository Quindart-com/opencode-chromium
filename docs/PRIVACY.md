# Privacy Policy

**Effective date:** November 24, 2026

Extension updates can open the public release-notes page on GitHub Pages. This can be disabled in the setup guide. Published managed runtimes can download matching releases and dependencies from npm in the background and activate after all browser sessions finish; automatic updates can be disabled under Settings → Updates. These requests disclose normal connection information to the hosting service, but do not include browser content, profile identifiers or decision credentials. Coordination records stay local and contain process identities, opaque session/profile identifiers, activity counts and release versions; they contain no browser content or tool arguments.

This privacy policy applies to the **OpenCode Browser Plugin** extensions for
Chromium-based browsers (Chrome, Edge, Brave, Chromium) and Firefox-based browsers
(Firefox, LibreWolf), published by Quindart as part of `opencode-chromium`.

## In short

opencode-chromium is a local browser-automation bridge. It lets an AI coding
assistant (OpenCode, Codex, MCP clients) drive the browser on **your own machine**.
Cloud decision assistance is off by default. The extension communicates with a
local native host. If you explicitly enable a decision provider,
the native host sends bounded search/replay intent and candidate descriptions to
the service you selected. Page text may contain personal information.
If you separately enable screenshot sharing for Jev or OpenAI Luna, an ambiguous visual
decision may also send one bounded, compressed screenshot of the controlled tab
to your selected service (OpenRouter or TypeSafe). Screenshots may contain personal information. Screenshot sharing
is off by default; Jev uses images only after an unsure text decision, and ordinary exact matches do not trigger
decision screenshots. You can turn off cloud assistance or screenshot sharing
in Settings.

## Shared site reads and task patterns

Each has its own switch in Settings.

- **Contribute task patterns** turns on when you turn on Action Memory, as noted
  beside that switch, unless you already chose a setting. If Action Memory was
  already on, it starts off. While Action Memory is recording, it shares the site
  and task category of successful agent reads on supported public sites to
  improve shared site reads. No URLs, package names, page text or credentials
  are sent. Contribution records expire within about two weeks. Turning it off
  stops sharing, withdraws recent contributions and turns off shared site reads.
- **Shared site reads** (off by default, available while task patterns are on)
  let agents read public fields on supported sites through the OpenCode Browser
  registry, hosted on Convex. For Hacker News it receives the requested fields
  and the public story ID. Supported npm packages are read directly from npm.

Registry requests carry a random pseudonymous key. Each service you contact
receives normal connection information, such as your IP address.

## What the extension does

- The extension receives tool calls from a locally running native messaging host
  (`com.opencode.browser.plugin`) and executes them in your copy of the browser.
- It can create and control tabs, read pages, download files, run searches
  against your browsing history, and deliver click, type, scroll, drag, and
  screenshot automation on your behalf.
- It keeps a small, user-visible "profile label" (for example `work` or `staging`)
  in `chrome.storage.local` so you can choose which open browser profile a tool
  call should use. You can clear it at any time from the extension popup.

## Content boundaries

Snapshot and pixel-diff baselines are temporary local artifacts. When requested,
their page text or images are delivered to your connected agent, whose model
provider may receive that content. The setup guide is bundled locally; it has
no analytics. Help and release-note links open GitHub only when you select them.

- **Local extension communication.** The extension
  talks to a native messaging host installed on your computer over the
  browser's native messaging channel. The native host calls TypeSafe or
  OpenRouter only after you enable a provider with the disclosed context sharing.
  Requests never silently switch providers. Browser content is not sent to Quindart.
- **Local models, local data.** Optional semantic page search downloads a model
  bundle (a standard Hugging Face transformer) to a local cache directory you
  can inspect and delete from the extension popup. Local semantic inference
  happens in the native host. Model downloads contact the model distributor.
- **Anonymous diagnostics, on by default.** The native host sends bounded, aggregated
  tool outcomes, allowlisted error codes, coarse timing, retry/recovery categories,
  release, browser family/major version and OS family through a Quindart endpoint
  to Google Analytics 4 when the release has a configured collector endpoint.
  Disable this in **Settings → Anonymous diagnostics** at any time. This applies to
  existing installations as well as new ones. Firefox also respects its optional
  technical-data permission. No browsing content, URLs/domains, profile identifiers,
  credentials, raw error text, stacks or persistent analytics identifiers are sent.
  Counters stay in memory until sent or discarded; disabling clears pending counters.
  A local running marker can report a possible crash, forced termination, or shutdown
  as an unclean exit on the next start. Each batch uses a fresh random analytics client
  ID. The collector excludes source IPs and browser user-agent strings from forwarded
  diagnostics and denies advertising consent. Network services receive normal
  connection metadata. Diagnostics are used only to measure and improve reliability.
  See [diagnostics](telemetry.md) for the fields, exclusions, environment opt-out and
  delivery limits.
- **No extension account.** Provider accounts and their data-handling
  policies apply separately when you enable cloud assistance. Keys can be supplied
  in Settings or the native host environment. Saved keys stay in private native-host
  state (DPAPI encrypted on Windows; owner-only files on macOS/Linux), never extension
  storage or agent responses. Local usage records retain timings and reported
  tokens/cost, without browsing context. Connection tests send synthetic data only.
- **No device identification.** The plugin, extension, and native host never
  read machine IDs, hostnames, usernames, MAC addresses, hardware serials, or
  install IDs, and never compute device fingerprints. The only persistent
  identifiers are a random per-profile UUID generated locally for routing
  requests to the browser profile you selected and, when the shared site
  features above are in use, their random registry keys. Profile IDs and labels can
  appear in agent tool responses or copied profile selectors; your connected
  agent or harness handles those responses under its own data policy. The
  routing ID is not used as a device fingerprint or silently sent to a decision
  provider as a device identifier.
  The extension popup shows this identifier **masked** by default (first and
  last four characters only); the full value is revealed or copied only through
  an explicit "Developer details" action. Cache locations are shown as "Local
  model cache"; the raw path is only ever copied on explicit request, never
  rendered. Behavioral privacy tests verify these
  guarantees, and store-listing images are generated from deterministic demo
  fixtures rather than live popups.
- **Controlled download observations.** Bounded in-memory download events are
  captured only when the browser attributes a download to a session's controlled
  tab. Unrelated downloads are ignored, and sessions can read or clear only
  their own events. Observed URLs omit credentials, query strings, and fragments;
  filenames contain only the basename, without local directory paths. Download
  observations are returned through agent tool calls and are not broadcast to
  other connected clients. The extension does not request the browser's global
  `downloads` permission.

## Action Memory

The opt-in **Action Memory** feature (off by default) stores a structured,
vector-searchable record of agent browser actions in a local SQLite database.
By design it contains **no page content**: no URLs, window titles, typed
text, form values, keystrokes, clipboard contents, screenshots, file paths, or
accessibility trees — only action names, hostnames, bounded element labels
(≤ 64 characters, passed through a privacy normalizer that strips email
addresses, UUIDs, long account-like numbers, URL query strings, tokens, and
filesystem paths), outcomes, and timestamps. Steps that need a value or URL at
replay time are stored as flags only; the value always comes from the live
agent request and is never persisted. Search queries are embedded for the
lookup and never stored; searchable chain text is generated purely from the
privacy-safe structured fields. The database is not encrypted; the record is
a what/where/result log, not a transcript. Delete (`memory delete --yes`) permanently removes the
database. Confirmed actions are never auto-purged; stale failed lessons are
cleaned up automatically per the quota and purge settings shown in the Action
Memory dashboard (extension popup → Action Memory).

## Permissions and why they exist

The extension requests the permissions it needs to operate as a general-purpose
automation bridge:

- `tabs`, `tabGroups`, `history`, `storage`: read and manage the
  parts of the browser you explicitly ask an agent to work with.
- `scripting`, `<all_urls>`, `debugger`: inspect page structure, run input
  automation, and capture what the agent needs to see. Pages are only touched
  when a tool call from a session you started asks for it.
- `nativeMessaging`, `alarms`: communicate with the locally installed native
  host and keep the service worker responsive during active sessions.

`debugger` and `tabGroups` are requested only by the Chromium extension. Firefox
and LibreWolf instead use a locally enabled Remote Agent through WebDriver BiDi
for browser-level automation. The plugin accepts only a loopback connection;
other local programs can also access an enabled Remote Agent. Fully exit and
relaunch the browser without the debugging flag to disable that listener. See
[Firefox setup](firefox.md) for launch instructions and connection checks.

You grant or deny these permissions at load time, and you can remove the
extension at any time.

## Children

This extension is not directed to children. Anonymous technical diagnostics are
described above; it does not intentionally collect children's personal information.

## Changes

If this policy changes, the updated version will be published at this URL and
the extension's store listing will note the change before it takes effect.

## Contact

Questions about this policy?

Email: **contact@quindart.com**<br>
Website: [quindart.com](https://quindart.com)<br>
Publisher: Quindart — 2/F, Tower 1, Tern Centre, 237 Queen's Road Central,
Sheung Wan, Hong Kong
