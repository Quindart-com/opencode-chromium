# Chrome Web Store Privacy practices tab copy (per-permission justifications)

Paste each justification into its matching field on the **Privacy practices**
tab of the item edit page, then certify the data usage declaration and Save
Draft.

## Single purpose description

> Browser automation for AI coding agents through a local native messaging bridge.

## alarms

> The service worker uses a one-minute `alarms` keepalive so an active automation session does not go idle and drop the native messaging connection while an agent is working.

## bookmarks

> Agents can list bookmarks to help users pick a page to automate (e.g. "open my saved work tab"). Bookmarks are only read when a tool call from a user-started session requests them; they are never modified or transmitted.

## debugger

> The extension drives real input automation (mouse, keyboard, scroll, drag) and page-state capture through the Chrome DevTools Protocol on tabs a session explicitly controls. The debugger attaches only when a tool call asks for it and detaches when the call or session ends.

## downloads

> Download lifecycle events (started/completed/cancelled) are reported back to the agent so it can wait for and locate files it triggered. Events stay local; nothing is uploaded anywhere.

## favicon

> Favicons are loaded so tab listings returned to the agent are human-readable. Favicon data is used locally only.

## history

> `history` powers "search my browsing history" requests from the agent so it can offer the user relevant pages. Queries are explicit, results are trimmed, and history data never leaves the device.

## host permission use

> `<all_urls>` is needed to inspect and automate arbitrary web pages the user asks the agent to work with. The extension only touches pages when a tool call from a user-started session requests it; it does not act on its own and sends no data anywhere.

## nativeMessaging

> The extension communicates exclusively with the locally installed native messaging host (`com.opencode.browser.plugin`) that runs the agent's browser bridge. This channel is local-only; no remote servers are involved.

## notifications

> Notifications surface short status/keepalive feedback during long-running automation so the user sees the session is still active. Locally generated only.

## readingList

> Lets an agent offer to save a page to the user's reading list when asked. Read/write only on explicit request, local only.

## remote code use

> The extension does not use remote code. It does not load or execute code from any remote server, and its content security policy is locked to `script-src 'self'`; no `eval` or `new Function` is used anywhere.

## scripting

> `scripting` injects the extension's own bundled cursor-overlay content script into controlled tabs and executes the review-friendly DOM helpers needed for automation. Only bundled, static files are injected — never remote or generated code.

## sessions

> Sessions lets a session restore its tab set if the browser restarts mid-automation, so agent work survives crashes instead of losing the user's pages. State is snapshotted locally only.

## storage

> `storage.local` persists the extension's own small state: a session/tab registry and the user's optional profile label (e.g. "work"/"staging") used to pick the right open browser profile. Data stays on the device and can be cleared from the popup.

## tabGroups

> Each agent session's tabs are grouped under a titled, color-coded group (visible in the toolbar) so the user always knows which tabs belong to automation and can close or release them as one unit.

## tabs

> Tabs are the core resource being automated: the agent opens, claims, lists, navigates, reloads, and closes tabs the user asked it to manage. New automation tabs are created in the background without stealing focus.

## topSites

> `topSites` lets the agent check whether a page the user asked for is already open in a pinned/frequent tab before creating a duplicate. Read locally, never transmitted.

## Data usage certification

> This item does not collect, transmit, or sell any personal or sensitive user data. All operations run locally on the user's device. (Certify this on the Privacy practices tab.)