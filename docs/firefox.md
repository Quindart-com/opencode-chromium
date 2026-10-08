# Firefox and LibreWolf

The Firefox MV3 add-on shares the Chromium popup and session lifecycle. Its stable identity is `opencode-browser-plugin@quindart.com`. Native messaging uses Mozilla's `allowed_extensions`; Chromium keeps its own `allowed_origins`.

## Guided setup

Install the signed add-on and run `npx -y opencode-chromium@latest setup --all`. Connect the extension to register its profile, then copy that profile ID from Profiles.

```sh
npx -y opencode-chromium@latest firefox configure --profile PROFILE_ID --port 9223
npx -y opencode-chromium@latest firefox status --profile PROFILE_ID
```

Launch that browser profile yourself with `--remote-debugging-port 9223`. Firefox binds its Remote Agent to loopback by default. The plugin accepts only `ws://127.0.0.1:PORT/session`, and verifies a random marker in the selected extension tab before associating it with a BiDi context. Matching URLs alone cannot claim a tab. A wrong profile, missing port, or unavailable agent produces an actionable setup error. Configuration does not restart or terminate an occupied browser.

The remote port is a local automation boundary. Other local programs can connect to it; use a dedicated profile when appropriate and close that browser when finished. Do not expose the port or use remote host flags. [Mozilla Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html).

## Capabilities

Core browsing uses WebDriver BiDi for trusted pointer/keyboard input, evaluation, navigation, screenshots, dialogs, and approved file inputs. Extension session ownership still controls admission and finalization. Native groups are used where supported; ownership bookkeeping applies otherwise. Raw CDP, Chromium traces, and capabilities the Firefox backend does not implement return an explicit unsupported result. PNG and JPEG screenshots are supported; WebP is unavailable on Firefox.

Windows, macOS, and Linux discovery includes Firefox and LibreWolf. Firefox 140+ is required. LibreWolf privacy settings may disable its Remote Agent; the health check reports this rather than silently changing preferences. No Android setup is provided. See release verification notes for the browsers and flows actually exercised.

## Reproducible build and listed releases

Use Bun 1.3.6, the committed lockfile, and the repository version being submitted:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run zip:extension:firefox
bun run check:firefox
bun run firefox:submit -- --dry-run
```

The Firefox workflow validates pull requests without publishing. On a forward version bump reaching master, it uploads a listed AMO version with source and build instructions. Repository secrets `WEB_EXT_API_KEY` (issuer) and `WEB_EXT_API_SECRET` authenticate publication. Credentials never belong in committed files or release notes.

The workflow retains the archive, source archive, and returned signed artifacts. Before uploading it checks for an existing version to avoid duplicate retries. Submission and publication are different states: a successful upload can be pending Mozilla review. The npm release does not imply that AMO has approved the add-on.

[Native manifest contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests) · [web-ext publishing reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/).
