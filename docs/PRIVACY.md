# Privacy Policy

**Effective date:** August 13, 2026

This privacy policy applies to the **opencode-chromium** extension for Chromium-based
browsers (Chrome, Edge, Brave), published by Quindart.

## In short

opencode-chromium is a local browser-automation bridge. It lets an AI coding
assistant (OpenCode, Codex, MCP clients) drive the browser on **your own machine**.
The extension **does not collect, transmit, or store any personal data** on any
remote server. Everything runs locally.

## What the extension does

- The extension receives tool calls from a locally running native messaging host
  (`com.opencode.browser.plugin`) and executes them in your copy of the browser.
- It can create and control tabs, read pages, download files, run searches
  against your browsing history, and deliver click, type, scroll, drag, and
  screenshot automation on your behalf.
- It keeps a small, user-visible "profile label" (for example `work` or `staging`)
  in `chrome.storage.local` so you can choose which open browser profile a tool
  call should use. You can clear it at any time from the extension popup.

## Data flows

- **All communication stays on your device.** The extension talks to a native
  messaging host installed on your computer over the browser's native messaging
  channel. Neither the extension nor the host sends data to Quindart, any cloud
  provider, or any third-party service.
- **Local models, local data.** Optional semantic page search downloads a model
  bundle (a standard Hugging Face transformer) to a local cache directory you
  can inspect and delete from the extension popup. Search happens locally in
  your browser tab.
- **No accounts, no telemetry.** The extension has no accounts, does not use
  analytics, and does not phone home. The vocabulary used with the native host
  never leaves your machine.

## Permissions and why they exist

The extension requests the permissions it needs to operate as a general-purpose
automation bridge:

- `tabs`, `sessions`, `tabGroups`, `bookmarks`, `history`, `topSites`,
  `readingList`, `downloads`, `downloads.ui`, `favicon`, `notifications`,
  `storage`: read and manage the parts of the browser you explicitly ask an
  agent to work with.
- `scripting`, `<all_urls>`, `debugger`: inspect page structure, run input
  automation, and capture what the agent needs to see. Pages are only touched
  when a tool call from a session you started asks for it.
- `nativeMessaging`: communicates with the locally installed native host.

You grant or deny these permissions at load time, and you can remove the
extension at any time.

## Children

This extension is not directed to children, and it does not collect information
from anyone.

## Changes

If this policy changes, the updated version will be published at this URL and
the extension's store listing will note the change before it takes effect.

## Contact

Questions about this policy?

Email: **contact@quindart.com**<br>
Website: [quindart.com](https://quindart.com)<br>
Publisher: Quindart — 2/F, Tower 1, Tern Centre, 237 Queen's Road Central,
Sheung Wan, Hong Kong
