# Liquid Glass page overlay: developer implementation spec

Architecture and security contract for the on-page board. The implementation uses standards-based backdrop blur and glass styling; native optics and SVG displacement are not claimed. The existing popup remains the trusted full-feature surface and fallback.

## 1. Goal and supported interpretation

Render the extension's contextual board, buttons, tabs, and controls **over the actual current webpage**, with the webpage visible through glass material. This requires a renderer in that webpage's DOM; the toolbar popup cannot sample another document or the desktop. Preserve existing features, agent session ownership, permission checks, privacy controls, and safe upload confirmation.

The visual target is a translucent contextual board with beveled controls over the current webpage. Native design-tool material parameters are visual targets, not executable CSS or proof of browser support.

Deliverable distinction:

- Baseline: same-document translucent material, live backdrop blur, restrained edge highlights, glass-styled controls, accessible opaque fallback.
- Optional enhancement: genuine local backdrop displacement/refraction only after a real-browser rendering test proves it works in the chosen engine.
- Not permitted: continuous screen capture, duplicating the page into a canvas, reading page pixels, attaching a debugger, or sending screenshots to a model just to draw glass.

## 2. Repository findings and integration map

This document describes the repository integration and security requirements. Validation evidence belongs in the pull request; the proposed enhancement tests below must not be mistaken for completed coverage.

| Existing file | Evidence / implication |
|---|---|
| `wxt.config.ts` | WXT/React, Manifest V3; existing `scripting`, `tabs`, `storage`, `nativeMessaging`, `<all_urls>` host permissions. Chromium also requests `debugger` and `tabGroups`; Firefox minimum is 140. Extension-page CSP uses self-hosted scripts/fonts/connections. `popup.html` is already web-accessible; that is not a grant of privileged messaging authority. |
| `extension-src/entrypoints/cursor.ts` | Existing programmatically injected unlisted script creates a fixed host and closed Shadow DOM. Reuse the pattern, not its cursor behavior or state ownership. Its root currently uses z-index 2147483647. |
| `extension-src/entrypoints/background/runtime-cursor.ts` | Uses `scripting.executeScript`, then extension messaging, with bounded reinjection. A separate interactive board must not be added to the cursor's pointer-events-none root. |
| `extension-src/entrypoints/background/runtime-popup.ts` | Existing popup requests and status ports. Some operations delegate to sender-aware modules; several other branches do not centrally classify sender privilege. Add explicit authorization before sharing handlers with a page renderer. This is an integration requirement, not a claim of an exploited vulnerability. |
| `extension-src/entrypoints/background/connection-panel.ts` | Connection controls explicitly reject content scripts. Preserve this boundary; do not remove it merely to make on-page controls work. |
| `extension-src/entrypoints/background/upload-consent.ts` | Upload preference changes require the popup. Approval requires the exact extension confirmation page, matching token and window/tab, with timeout and cancellation. Preserve these checks. |
| `extension-src/entrypoints/background/tab-ownership.ts` | Existing agent ownership checks and internal-page exclusions. Opening the board must not claim a tab or attach automation. Overlay eligibility must be stricter than this helper alone: it intentionally allows some URLs unsuitable for a board. |
| `extension-src/entrypoints/popup/App.tsx`, `api.ts` | Current views and extension-only transport. Extract view presentation and an explicit capability-aware transport; do not mount `App` unchanged in a content script. |
| `extension-src/entrypoints/background/runtime-methods.ts`, `src/browser/operations/` | Observations, screenshots and browser operations need explicit exclusion/occlusion handling for the new board so agents do not target their own extension UI. |
| `scripts/fixtures/chromium-extension.js`, `scripts/verify-popup.js`, `scripts/verify-uploads.js`, Firefox verifiers | Existing real-extension, UI and consent fixtures to extend. Standalone HTML renders cannot validate extension authorization. |

Implementation modules:

- `entrypoints/page-panel.ts`: unlisted isolated-world bootstrap and idempotent controller.
- `page-panel/App.tsx`: contextual renderer with safe view capabilities.
- `page-panel/material.css`: same-document glass and opaque variants.
- `page-panel/controller.tsx`: mount, position, focus, visibility and cleanup.
- `background/page-panel.ts`: trusted launch, sender-bound registration and lifecycle.
- `page-panel/protocol.ts`: small strict message union and output projection.
- Shared presentational components and transport interfaces extracted from the popup as justified by behavior; no runtime/native-host protocol change unless separately needed.

Keep the repository's 500-line production module limit and subsystem boundaries.

The initial on-page implementation exposes bridge/harness state, current-profile memory aggregates, bounded provider/period usage and charts, view navigation and presentation controls. Full profile editing, credentials, uploads, maintenance and other native mutations remain available through an explicit trusted-panel handoff. No generic content-to-native RPC is exposed.

## 3. Architecture and trust boundaries

```text
Explicit user action in real extension UI
          |
          v
MV3 background: choose active tab, check URL/permissions, create launch lease
          |
          v
scripting.executeScript -> top frame, ISOLATED world, packaged renderer
          |
          v
Private controller -> closed ShadowRoot in webpage DOM -> React board
          |
          +---- typed runtime port ----> bounded background projections
          |
          +---- request trusted UI ----> real extension popup/tab/window

Webpage scripts / page messages --------X--------> privileged background methods
```

The content script's JavaScript world is isolated, but its DOM is shared with an untrusted webpage. Shadow DOM provides style/component encapsulation; it is not a privilege, anti-clickjacking, or confidentiality boundary. A hostile page can obscure, remove, transform or imitate injected UI. `event.isTrusted` alone does not establish informed user approval.

Scope the material stylesheet to that closed root. Attempt a constructed stylesheet where supported, with a `style.textContent` fallback inside the root: Firefox content-script Xray wrappers reject constructed-sheet adoption. The real Firefox verifier exercises this fallback on a page whose CSP blocks inline page styles and scripts; do not bypass the page policy or open the shadow root to solve it.

**Decision:** use same-document Shadow DOM for live page glass and low-risk controls. Keep credentials, full local paths, permission-expanding settings, destructive operations, runtime installation/major-upgrade approval, and upload decisions in trusted extension-origin UI. The overlay can launch those flows; it cannot approve them. This preserves feature access without moving security-critical decisions into page-controlled presentation.

A cross-origin extension iframe is an alternative for isolating UI internals, but its own `backdrop-filter` cannot sample the parent webpage. A split design would need a separate parent-document glass plate behind a transparent iframe, with authenticated geometry coordination, and still would not make page presentation immune to clickjacking. Do not choose this architecture by accident or weaken sender checks to support it. It is not required for the baseline.

## 4. Permissions and launch behavior

1. Keep the existing action popup. Add an explicit presentation action there, such as “Open on this page,” or a separately reviewed extension command. Do not silently replace the popup or automatically inject on every host.
2. Resolve the current active tab in the background at the time of the gesture. Do not trust a webpage-supplied tab ID, URL, origin or frame ID.
3. Baseline eligibility is top-level HTTP(S) HTML documents with an effective granted host permission. Existing `<all_urls>` plus `scripting` generally supplies the capability; users/enterprise policy can withhold access. Check the actual operation.
4. The standard on-demand injection architecture for a new extension is `activeTab` plus `scripting`. For this existing project, do not add `activeTab` in this task merely because examples use it; this repository already requests broad host access. A future move to on-demand `activeTab`/optional hosts is a separate product/permission migration.
5. No new debugger, screen-capture, webRequest, clipboard-read, MAIN-world, all-frames, or broad web-accessible-resource requirement is justified by glass rendering.
6. Inject only a packaged entrypoint into frame 0 using the isolated/default execution world. Do not use remote code, eval, inline page script tags, `unsafe-eval`, or weakened CSP.
7. A script injected through `scripting` does not need to become web-accessible. Keep any genuinely necessary packaged assets narrowly declared; do not expand the existing popup WAR entry to all bundles.
8. Preflight, injection result and renderer HELLO must all match the intended tab/current document. Navigation races must fail closed. A successful injection promise alone does not establish UI readiness.
9. Unsupported/restricted pages retain the real extension popup, with a concise explanation. No retry through CDP, browser flags or CSP bypass.

## 5. Minimal context and messaging contract

Rendering browser-composited glass requires no extraction of page DOM, text, cookies, screenshots or pixel data. Initial context is presentation-only: schema version, instance ID, current-view enum, theme/material preference, safe position, and a sanitized background projection. If an origin label is useful, use the browser-observed origin, not URL query/fragment, credentials or full navigation history.

Current message contract:

- Trusted popup launch: `{ type: 'PAGE_PANEL_OPEN' }`.
- Background-to-top-frame bootstrap: `{ type: 'PAGE_PANEL_SHOW', instance }`.
- The renderer connects a document-bound `page-panel:<instance>` runtime port.

```ts
type PagePanelRequest =
  | { type: 'refresh'; usage?: { period: UsagePeriod; provider: AllowedProvider } }
  | { type: 'open'; view: 'overview' | 'profiles' | 'settings' }
  | { type: 'close' }
  | { type: 'hidden'; id: string };
```

`UsagePeriod` and `AllowedProvider` are finite enums in `page-panel/protocol.ts`, not arbitrary native query strings. Replies are projected `snapshot` data or a generic `unavailable` state. Background `capture` messages temporarily hide/restore the board; `hidden` acknowledges only the correlated hide operation.

- Validate strict schemas, lengths and rate limits. Reject unknown fields and operations; never expose generic `rpc.request(method, params)` or arbitrary URLs to content UI.
- Bind an authorized renderer registration to browser-supplied `sender.id`, `sender.tab.id`, `sender.frameId === 0`, and document identity where available. Use a document-scoped generation/lease on platforms that do not expose the same identity fields. Validate again after background restart/reconnect.
- Instance/request IDs provide correlation, not proof of authority; anything placed in DOM is readable/observable and cannot be a secret capability.
- No `window.postMessage`/CustomEvent bridge from page scripts to privileged APIs. No page-origin requests are accepted as panel actions.
- Add sender classification to **all** relevant existing popup handlers and the `popup-status` port before exposing the new entrypoint. Preserve dedicated cursor messages with their own top-frame/tab checks. Avoid one giant “same extension ID means trusted” guard.
- Summaries are explicit allowlisted DTOs: bridge readiness, masked current profile, bounded aggregate usage, safe memory status, and sanitized error codes. Never send API keys, full identifiers/paths, raw native errors, pending upload tokens or cross-profile private data to the page renderer.
- Limit content actions initially to local view selection, close/minimize/position, theme/material preference, safe aggregate filtering, and opening a trusted feature view. Any later native mutation requires its own threat model, current sender authorization and trusted confirmation as appropriate.
- Opening trusted UI accepts an enum, constructs the extension URL internally, and does not execute work on arrival. If using `popup.html#settings`, add and test explicit routing: the current `App` does not already implement hash selection.
- A background worker can suspend. Store only non-sensitive presentation preference if persistence is required. Reconnect with backoff; reauthorize and refresh state instead of keeping stale grants or adding artificial keepalive traffic.

## 6. DOM, lifecycle and page behavior

- Mount one privately owned host per top-level document. Keep the controller reference/version in the isolated world. Do not delete arbitrary page elements just because they match a public ID.
- Attach a closed ShadowRoot; mount React with cleanup. Reset inherited font, direction and layout intentionally and set semantic theme variables on the host. `all: initial` alone does not reset custom properties or neutralize ancestor transforms.
- Use a fixed-position layout host. Baseline max board width 420px, responsive to 320px/viewport minus safe margins. Constrain height to the visible viewport with internal scrolling. Respect `visualViewport`, zoom and keyboard resize; clamp persisted position after changes.
- Outside the visible board, pointer events pass to the page. Do not put an invisible full-screen input shield over the website. Dragging uses pointer capture only for the drag duration and supports keyboard reposition/reset.
- Reserve a layer below the existing cursor; do not fight page top-layer dialogs/fullscreen with unbounded reinjection. If a page modal occludes or conflicts with the board, allow dismissal/fallback to trusted UI. Max z-index is not a guarantee of topmost rendering.
- The board is a labeled non-modal region. Do not make the rest of the webpage inert, steal focus on background updates, or trap focus. Escape closes when focus is within the board; do not swallow unrelated page Escape behavior. Restore the launching page focus when feasible.
- Use explicit Close and Collapse controls. Closing unmounts, removes only owned nodes, disconnects ports, clears subscriptions/timers/observers/listeners/RAF, and leaves agent sessions and user tabs intact.
- Full navigation destroys the old renderer and invalidates its registration. Do not auto-reopen on the new document by default. SPA same-document navigation may keep the board; revalidate context and reset transient sensitive state. No history API monkeypatch is needed just for glass.
- Handle BFCache `pagehide`/`pageshow`: stop work on hide; restored pages must reauthorize before accepting fresh data/actions. Handle document replacement and extension update/invalidation with a closed or disconnected view, not zombie controls.
- A narrowly scoped observer may detect removal of the owned host. Do not continuously watch/serialize the whole page or endlessly recreate UI a page/user removes. One bounded recovery attempt followed by fallback is sufficient.
- No body padding/layout rewrite, global CSS rules, global selection/copy changes, or page navigation mutation. Browser page functions must remain intact outside the panel.

## 7. Agent observation and screenshot coexistence

The new board is website DOM and can otherwise appear in DOM inspection, screenshots and target finding.

- Add an explicit per-document overlay registry/exclusion contract for owned extension UI. Do not ignore arbitrary page nodes solely because their ID/class looks like the extension's marker.
- DOM observations, searchable text, accessibility summaries and target matching must exclude the extension board and its shadow subtree. Never allow a page element that imitates the marker to confer any privilege.
- Page-target automation must not click or type into overlay controls. A panel obscuring a website target must return an obstruction result or follow a reviewed temporary-hide policy; do not automatically move consent UI or replay uncertain mutations.
- For an **already authorized** page screenshot, hide only the owned board for the capture, then restore it in `finally` on success, error or timeout. Synchronize concurrent captures with a refcount/token and document identity. This must not independently authorize screenshots.
- UI screenshots requested for review are a different explicit capture mode and can include the board. Never include secrets from the trusted extension UI.
- Preserve cursor, dialogs, tab ownership, browser_finalize behavior, website upload picker and existing screenshot/image-sharing consent.

## 8. Material implementation: glass versus refraction

Because the host is in the page document, CSS `backdrop-filter` can sample the real rendered webpage underneath. It does not give JavaScript access to those pixels.

Separate visual layers so foreground labels/icons remain sharp:

```text
owned transparent layout group
  material plate (non-interactive; backdrop blur / optional displacement)
  solid contrast variant when needed
  crisp text, icons and interactive controls
```

Implemented material uses the denser full-screen suite, not the separate art-directed study. All text and parent groups remain at opacity 1; the alpha values below apply only to fills.

| Token | Light | Dark |
|---|---|---|
| Shell/card/button fill | white 10% | #162238 10% |
| Selected tab fill | white 30% | white 30% |
| Other tabs and fields | white 12% | #162238 12% |
| Glass rim | 1px white 60% | 1px white 30% |
| Primary text | #172033 | #F2F5FC |
| Button/tab text | #172033 | #F3F5FC |
| Secondary text | #43516A | #BDCAE0 |
| Field border | #65758E | #8594AE |
| Solid fallback | #F5F7FC | #202838 |
| Inner highlight +2/+2, blur 3 | white 55% | white 24% |
| Inner highlight -2/-2, blur 6 | white 40% | white 15% |
| Shadow 0/8, blur 20, spread -4 | #121A2E 13% | #121A2E 22% |

Use shell/card/button/tab/field corner radii of 32/24/22/20/20px respectively. Tabs are at least 44px high; fields 40px; action buttons 36–40px. Fields deliberately have no GLASS effect. A 2px foreground marker supplements the active tab's subtle translucent fill so selection does not depend on a small alpha difference.

The suite's native GLASS targets are radius 8, refraction .7, depth 18, angle -45 degrees, dispersion .12, intensity .75 light/.45 dark. These are visual targets, not CSS equivalents. The standard renderer uses backdrop blur 16px/saturation 115% plus the bounded inset highlights and shadows. Text is never filtered or faded. The separate material study's radius 10/dispersion .15 and stronger shadow are not mixed into these tokens.

Clear fills cannot guarantee readable foregrounds over arbitrary websites. The renderer therefore defaults to solid material below 480px and when nine bounded CSS-background samples do not support 4.5:1 for the text/control palette. Unknown images, color spaces, blends or deep ancestry also choose solid. This uses CSS colors only, with at most 32 ancestors per sample; it reads no screenshots/canvas pixels, collects no page text and transmits no samples. Scroll, resize and page-theme changes trigger bounded frame-coalesced refreshes; listeners and observers are removed on close.

The existing transparency checkbox permits an explicit clear/solid choice for the current opening. System reduced-transparency, increased-contrast and forced-color preferences take precedence. Manual clear mode is an aesthetic choice, not a universal WCAG guarantee. The heuristic cannot model every raster, animation or compositor effect; it must not be marketed as pixel-level contrast verification. Tests separately show the clear material over matching review backdrops and the default solid fallback over incompatible colors and constrained layouts.

```css
.glass-plate {
  background: var(--glass-solid);
  border: 1px solid var(--material-edge);
  border-radius: inherit;
}
@supports (backdrop-filter: blur(1px)) {
  .glass-plate {
    background: var(--glass-fill);
    backdrop-filter: blur(16px) saturate(115%);
  }
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .glass-plate { background: var(--glass-solid); backdrop-filter: none; box-shadow: none; }
}
@media (forced-colors: active) {
  .glass-plate { background: Canvas; border-color: ButtonText; backdrop-filter: none; box-shadow: none; }
}
```

No blanket `opacity` on a container: it fades text and affects compositing. Ancestor filters, opacity, masks, containment and backdrop roots can change sampling. Nested glass controls may sample an already filtered parent rather than the original page; test the intended layer composition instead of assuming every nested control refracts raw page pixels.

**True refraction:** blur/saturation/highlights are not displacement. A candidate experimental renderer can apply a packaged/generated normal-map SVG filter with `feDisplacementMap` to the backdrop plate, not the text. A CSS parser accepting `url(...)` is not proof that SVG backdrop filtering renders in a browser, inside Shadow DOM or under the site's policies. Require pixel-based fixtures in each supported engine; otherwise select the standard glass renderer. No page screenshots are required to generate a geometry-only normal map. Keep map resources local and CSP-compatible. Do not use `filter: url(...)` on the whole board: that distorts text/controls rather than only the backdrop.

Do not promise native Apple optics or tutorial parity. If convincing displacement fails cross-browser/performance tests, retain honest live-page frosted glass with an explicit design annotation identifying the enhancement as unavailable.

## 9. Accessibility and privacy invariants

- Test 4.5:1 ordinary text and 3:1 essential non-text cues against the **composited** material, not just its alpha color. The light/dark reading tokens passed calculated text contrast over pure black/white, but every corrected control/state still needs testing.
- Preserve clear selected tabs, visible switch thumb, 2px focus indicator, accessible names and keyboard operation. At least 24px targets; prefer 36–40px controls here. Do not communicate status through color alone.
- Respect reduced transparency, increased contrast, forced colors and reduced motion. Remove displacement, blur and nonessential highlights in opaque modes; remove nonessential animation in reduced motion. Do not animate blur radius or run perpetual pointer-light tracking.
- The reduced-transparency media query is not universally exposed. Unsupported must never be interpreted as explicit consent to transparency. Conservative backing must remain readable everywhere; a reusable material override can be provided if approved as product scope.
- Private content remains in real extension UI. API-key entry, key removal, full paths, upload filenames/destination approvals, screenshot-sharing consent, unconfirmed-upload settings, cleanup/destructive actions and major runtime approval must not be silently relocated into a webpage.
- The overlay must not send webpage data to providers just for visual effects, infer consent from its presence, or request broader permissions when injection fails.

## 10. Restricted and unsupported pages

Start with HTTP(S) top documents only. Reject browser/internal and extension schemes, web store/add-on installation pages, restricted enterprise hosts, browser PDF viewers, reader/view-source pages, data/blob/about documents, and hosts with withheld permission. Local files and incognito require their existing browser opt-ins and a separate explicit support decision; do not enable them automatically.

URL checks are preflight assistance, not the final authority. Catch the real `scripting` failure and show “This page cannot display the on-page panel. Use the extension panel.” Keep the fallback usable without native-host access. Do not work around restricted pages using CDP, screenshot clones, changing browser settings or injecting into a different frame.

## 11. Performance and compatibility gates

- Chromium/Edge and Firefox 140+ are the implementation targets implied by this repository. No Safari support claim is added by the design.
- Baseline backdrop blur is broadly supported; SVG-backdrop refraction is a separate renderer capability. OS preference propagation, Shadow DOM effects, page CSP/Trusted Types, GPU configuration and browser versions need actual execution tests.
- Start with one board material and a bounded number of visible control plates. Avoid independent nested filters for every row, table cell and icon. Cap blur at the chosen fixed radius; no animated SVG noise/displacement maps.
- Update only on interaction/data changes. Suspend polling/animation while hidden or collapsed; disconnect or slow bounded subscriptions appropriately. The native-host protocol and unrelated sessions remain unaffected.
- Profile actual page scrolling, board scrolling, open/close and resize with video/complex pages behind the board on representative low-end hardware. Record browser, OS, GPU, viewport, trace and before/after. No universal FPS or GPU-cost claim can be made from a headless static study.
- A performance regression or unavailable compositor selects the standard/opaque material; do not degrade readability or keep capturing page images to rescue the appearance.

## 12. Implementation sequence and acceptance tests

1. Add entrypoint, isolated mount/cleanup and restricted-page fallback with an opaque board. Validate document-bound lifecycle before effects.
2. Add strict background transport, output DTOs and sender classification. Reuse presentational views through capability-aware adapters; keep privileged workflows in real extension UI.
3. Add standard live-page glass and semantic controls. Verify CSS isolation, focus, click-through and agent exclusion.
4. Implement optional refraction only behind proven renderer capability and performance tests; preserve equivalent fallback geometry.
5. Extend real Chromium and Firefox fixtures; rerun existing build, type, architecture, package, native-host, popup and upload gates.

Required new tests:

| Area | Acceptance |
|---|---|
| Launch / duplicate launch | One interactive board in top frame only; no debugger attach or ownership claim. Rapid repeated clicks do not duplicate mounts. |
| Navigation race / reload / SPA / BFCache | Old document loses authority; same-document route changes remain correct; restored pages reauthorize; no zombie port or timers. |
| Worker restart / extension update | Reconnect is bounded and revalidated; stale actions fail visibly; no artificial worker keepalive. |
| Restricted / denied host | Clear fallback, no bypass, no extra permission request. Test Chrome/Firefox store pages, browser pages, PDF, file, enterprise/withheld access. |
| CSS / CSP / Trusted Types | Hostile global styles, transformed ancestors, strict policy and hostile DOM removal cannot cause unsafe fallback or page breakage. |
| Security | Website `postMessage`/CustomEvent, forged IDs, subframes, stale documents and arbitrary RPC all fail. No secret appears in page DOM/messages/storage. |
| Sensitive flows | Content renderer cannot configure upload permissions, resolve upload tokens or invoke connection mutation directly. Real extension window still cancels/approves/expires correctly. |
| Interaction | Outside clicks/scroll/typing remain page-owned; drag capture releases; keyboard tabs/Escape/focus restoration work; page modal/fullscreen conflict has safe fallback. |
| Automation coexistence | DOM/search omit actual owned board; page spoof markers are not trusted; obstructed page targets are handled; authorized screenshots hide/restore board even on failure and concurrency. |
| Glass renderer | Pattern/checkerboard and moving page content visibly blur through board/buttons; text stays crisp. Pure black/white, high-frequency backgrounds, video, zoom and scrolling remain legible. |
| Refraction renderer | Pixel fixture proves actual backdrop displacement, not foreground distortion; SVG failure selects baseline in Chromium and Firefox. Parser support alone does not pass. |
| Accessibility | Light/dark, opaque, increased contrast, forced colors and reduced motion; 320px/narrow viewport; 200% zoom; keyboard and screen reader; contrast and targets. |
| Performance / cleanup | No work while collapsed/hidden beyond justified subscriptions; no retained hosts/listeners after close; traces show acceptable measured cost on agreed target hardware. |

Preserved regression commands include `bun run build`, both extension builds, `bun run typecheck:extension`, `bun run check`, `bun run verify:popup`, `bun run check:firefox`, onboarding and upload verifiers, and real-extension browser fixtures. Select focused tests after each stage and run the full relevant gate before release. Do not claim this proposed overlay has passed them yet.

For real Firefox UI verification, let the temporary add-on open and close its trusted page through its own `tabs` API. Firefox 157 restricts privileged WebDriver navigation and execution contexts. The fixture reuses `web-ext`'s existing loopback debugger, scoped to that temporary add-on, for extension-page inspection; WebDriver interacts only with the owned HTTP fixture. Do not enable system access, alter browser policies, or add production debug hooks to bypass those restrictions.

## 13. Figma handoff requirements

The new direction must show actual website content beneath the board, not a screenshot pretending the toolbar popup is transparent. Mark the website as example context, not a component/data source. Include glass buttons, tabs and controls plus clear focus/pressed/loading/disabled variants. Annotate standard glass versus experimental displacement and the opaque fallback.

Show Overview, Profiles, Settings, expanded controls, disconnected/recovery, update waiting/error, dark/light, narrow viewport, opaque/increased-contrast, minimized and moved-board states. For security-critical controls, prototype a transition to trusted extension UI, including upload request/cancel/allow/expired and credential entry. A simulated Figma flow must not be described as runtime authorization.

Preserve baseline and prior design references when updating design deliverables. Keep component identities and validate prototype destinations; prototypes do not establish runtime authorization.

## 14. Official references and verification limits

Read during this task through official documentation repositories:

- Chrome content scripts, isolated worlds and programmatic injection: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/content_scripts/index.md
- Chrome messaging security, including less-trusted content scripts: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/messaging/index.md#content-scripts-are-less-trustworthy
- Chrome scripting API: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/reference/scripting/index.md
- Chrome activeTab: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/manifest/activeTab/index.md
- Mozilla content-script access/restricted-domain rules: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts ; inspected source: https://github.com/mdn/content/blob/main/files/en-us/mozilla/add-ons/webextensions/content_scripts/index.md
- Mozilla executeScript, including cross-browser permission behavior: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript ; inspected source: https://github.com/mdn/content/blob/main/files/en-us/mozilla/add-ons/webextensions/api/scripting/executescript/index.md
- Mozilla web-accessible resources: https://github.com/mdn/content/blob/main/files/en-us/mozilla/add-ons/webextensions/manifest.json/web_accessible_resources/index.md
- CSS backdrop operation/root: https://drafts.csswg.org/filter-effects-2/ ; inspected source: https://github.com/w3c/csswg-drafts/blob/main/filter-effects-2/Overview.bs (draft, with open backdrop-root issues).
- Browser compatibility data: https://github.com/mdn/browser-compat-data/blob/main/css/properties/backdrop-filter.json and https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json
- User preferences: https://github.com/w3c/csswg-drafts/blob/main/mediaqueries-5/Overview.bs
- WCAG text/non-text contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html and https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html ; corresponding W3C repository source inspected.

The automated verifiers distinguish packaged-renderer fixtures, real-extension authorization/consent checks and screenshot review. They cover clear material on controlled light/dark backdrops, solid contrast fallbacks, selection frames and the protected flows. No SVG displacement, physical refraction, actual-OS preference propagation or GPU-performance certification is claimed. Keep the PR in draft until the full visual review is accepted.

Native platform material references: https://developer.apple.com/design/human-interface-guidelines/materials and https://developer.apple.com/documentation/technologyoverviews/liquid-glass . CSS styling does not claim native-platform optical parity.

## Trusted surfaces and implementation details

The popup, setup guide and release archive draw an extension-owned CSS abstract backdrop. They use the same glass rims, pill controls and blue/slate typography as the board, without pretending to blur the webpage behind a toolbar popup. Inter Variable v4.1 is bundled locally under the SIL Open Font License; no remote font service is contacted. The on-page renderer requests only its packaged font, with a system-font fallback where page policy prevents loading.

Major-version updates open a dedicated trusted review with backend-provided current and target versions. Approve invokes the existing updater with explicit major-upgrade approval; missing version information disables approval. Not now, Back to Settings and Escape leave the selection unchanged. This retains existing updater semantics: the displayed target is informational, rather than an added atomic version-pinning guarantee. Native input trust is checked before approval. Prototype simulation annotations and simulated success transitions are excluded.

A failed file-description or immutable-snapshot preparation can open a separate trusted failure window. Only these pre-attachment failures establish the statement that nothing was sent; an attachment callback failure does not show that claim. Its opaque token and window/tab binding cannot approve a file. Review new request only focuses a genuine later pending request for the same destination, when one exists; the new request still requires its own original consent. Back to consent preview stays disabled because a failed request has no valid preview to restore. Closing, cancelling or timing out the failure window cleans up its informational record. The original approval, cancellation, timeout, immutable snapshot and file-release checks remain in force.

The hosted archive preserves authoritative release text, anchors and existing link destinations. Each older release owns an independent native disclosure, including its expanded label and aria-expanded state. Desktop and mobile use natural document scrolling around the responsive rounded shell. Browser screenshot fixtures cover actual guarded review, immutable preparation failure, expired upload, connected board, all three views and archive disclosures in both themes; fixture states do not prove live installation or upload success.

### Compact overview and trusted-surface treatment

The default contextual overview preserves all harness connection rows, assistance status, input/output token totals with their current service/period scope, and memory status. Filters, call counts, cost and trend remain in a native Usage and performance disclosure. Its footer sits outside the scroll region so its material preference and trusted-panel handoff remain reachable when details expand or the viewport narrows. These controls intentionally retain functional information and accessibility capabilities absent from the compact prototype study. Populated connection screenshots use synthetic renderer data; separate real-addon fixtures establish injection and authorization.

Standalone trusted pages use a plain white canvas, including when the system prefers dark mode. Design-only gradients and colored artwork are omitted from the shipped UI. The injected page board remains separate: it samples the real webpage behind it and keeps its contrast-driven opaque fallback.

Brand rows and headings are plain text/logo content without glass capsules. The archive's Get started link has its own glass action treatment. Informational cards retain the suite's grouping and spacing; text itself receives no pill surface.

The hosted archive uses natural document scrolling and an 880px maximum-width shell, retaining release anchors and content. Browser checks cover the plain canvas, unboxed brand row, glass action, contrast, responsive layouts, and disclosure behavior. Guarded upload and major-upgrade actions keep their explicit approval semantics.
