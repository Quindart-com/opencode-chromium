# Ladybird ⚑ Experimental

Ladybird adds an independent rendering engine for inspecting pages and trying common browser actions. The plugin runs it headless in a disposable profile. A detected or configured driver appears as **Ladybird (Experimental)** in the normal profile selector.

## Setup

Install [Ladybird](https://ladybird.org/download/) in the environment where the browser will run. The Ubuntu alpha package includes WebDriver at `/opt/ladybird/bin/WebDriver`. The plugin discovers that path on Linux. On Windows, install the Linux package inside a WSL2 distribution and configure its driver from PowerShell.

    npx -y opencode-chromium@latest ladybird configure --wsl Ubuntu --driver /opt/ladybird/bin/WebDriver
    npx -y opencode-chromium@latest ladybird status

For an unpacked package or a source build on Linux, supply the absolute path using `ladybird configure --driver`. The macOS launcher path is recognized on Apple silicon, with integration verification pending. Use the Ladybird WebDriver executable that ships with or was built alongside the browser.

Select the profile by the ID `ladybird` or its displayed label. For example, send this to `browser_session` to open the profile, then use `new-tab` or start `browser_run` with a navigation step.

    {"action":"open","profile":"ladybird","sessionId":"ladybird-check"}

The first managed tab launches the driver on an OS-assigned loopback port. On Windows, WSL must forward localhost to the distribution. A start failure can indicate that WSL lacks system resources or that the driver executable or its runtime libraries are unavailable. The headless launcher uses CPU painting for screenshot compatibility.

## What works in this implementation

- Navigate to HTTP(S) pages, reload, move backward or forward, and manage tabs spawned for the current session.
- Read DOM text and controls, search by words, and use a selector or a returned reference for supported element actions. References stay scoped to the tab and become stale when their element is detached or the document is replaced.
- Click, focus, type in text fields, send common keyboard actions, and capture viewport PNG screenshots. On the tested alpha, Ladybird emitted trusted click and keydown events but marked the text input event as untrusted. Sites that depend on trusted input events may behave differently.
- Finish the session with `browser_finalize`. It returns managed tab details and closes the browser and its driver. The runtime also closes the browser on shutdown or after ten minutes without browser operations.

Ladybird uses the DOM for observations and supports basic lexical search. Personal tabs, visible handoff, file picking and uploads, raw CDP, frame targeting, network and console diagnostics, origin-restricted sessions, and full-page or clipped captures are unavailable in this implementation. Navigation waits for the document to finish loading on every request. The alpha can stall element clicks with the earlier WebDriver page-load strategy.

Keep the driver on loopback. The plugin starts its own local process, and a Ladybird WebDriver port accepts local automation without authentication.

## Verify on a pinned Linux build

    LADYBIRD_TEST_DRIVER=/opt/ladybird/bin/WebDriver bun scripts/verify-ladybird.js

The integration check runs the four public tools against a local form fixture and removes the temporary configuration and browser session after the run. The PR workflow uses Ladybird 2026.47.7 on Ubuntu 24.04.
