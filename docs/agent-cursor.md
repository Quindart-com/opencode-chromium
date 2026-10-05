# Agent cursor overlay

Every controlled tab shows where the agent is working. The cursor glides to the
element an action is about to use, plays an animation for what that action is,
and carries a small pill with the session's name.

The overlay is injected as two content scripts (`content-scripts/cursor-theme.js`
and `content-scripts/cursor.js`) into a closed shadow root. It is
`pointer-events: none`, sits at the maximum z-index, and never changes the page's
layout, scroll size, or input handling. Cursors are hidden at the end of a turn
and whenever the tab is closed or detached.

## Design origin and attribution

The pointer silhouette, the glow and outline paint stack, the per-session colour
palette, the action set, the badge metrics and the motion model are ported from
the [Cua Driver](https://github.com/trycua/cua) cursor overlay
(`libs/cua-driver/rust/crates/cursor-overlay`), which is MIT licensed:

```
Copyright (c) 2026 Cua AI, Inc.
SPDX-License-Identifier: MIT
```

Cua rasterizes bounded vector frames with Skia. A page cannot, so the same
geometry is emitted as inline SVG. The differences that remain are deliberate
and are listed under [Adaptations](#adaptations).

## Pointer

| Property | Value |
| --- | --- |
| Canvas | 128 × 128 units, rendered at a 42 px footprint |
| Silhouette | 8-vertex closed cubic bézier, hand-authored swept arrow |
| Hotspot | (55, 30) — the tip is the anchor, and always the rotation pivot |
| Body | session fill with a white outline 5 units wide |
| Halo | eight concentric strokes of the same path, 44 → 7 units, fading outward |
| Heading | `heading − 45°`, so movement at 45° renders the artwork unrotated |
| Idle float | 4 s cycle: ±5 units horizontal, `6·cos − 5` vertical, ±2.5° roll |

The white outline and every other colour are never tinted; only pixels matching
the Cua blue key colour are substituted. That is what keeps an agent-coloured
cursor readable on any page background.

## Per-agent colours

Each session owns its own cursor. The session id selects a colour the way the
source does: a trailing `-`, `_` or `.` plus a number is a 1-based palette index,
a trailing single letter indexes the alphabet, and anything else hashes with
FNV-1a. `default` and an empty id keep the Cua blue `#5EC0E8`.

| | | | | | | | | |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `#B284FF` | `#F784AA` | `#60DAAE` | `#F4B242` | `#4CCCE0` | `#DD71EC` | `#E85262` | `#B8DC36` | `#507EEC` |

Concurrent agents therefore look different without any styling argument.

## Actions

Twelve animations from the source are kept. A tool or run-step is mapped to one
action in `src/browser/cursor.js`, and a gesture batch is mapped in
`extension-src/entrypoints/background/cursor-state.js` from the CDP input it
actually dispatches.

| Action | Playback | Used for |
| --- | --- | --- |
| `observe` | loop | page search, inspect, visual map, snapshots, screenshots, locator reads, console/network events, hover |
| `click` | one-shot | click, double-click, DOM click, locator click |
| `text` | held | type, DOM type, locator fill, clipboard write |
| `key` | one-shot | keypress |
| `scroll` | loop | scroll |
| `drag` | held | drag |
| `navigate` | one-shot | `browser_move`, navigate, back, forward, reload, new/closed tabs |
| `transfer` | loop | uploads, downloads, finalize |
| `record` | loop | trace record and analyze |
| `system` | loop | configure, profile selection, session naming, turn end, dialogs |
| `app` | one-shot | reserved for application-level tools; nothing maps to it yet |
| `idle` | resting | the default resting cursor |

An action that is still held or looping returns to `idle` after a bounded
window, so a stale animation never sits on a finished tool call.

## Label

The pill sits on the pointer's anchor — one `POINTER_ANCHOR_OFFSET` (16 px) along
the heading from the tip, then 25 px below it — matching the source layout.

| Property | Value |
| --- | --- |
| Size | 28 px tall, 14 px radius, 10 px horizontal padding, 55 px to 188 px wide |
| Text | the session name, white, 11.5 px, truncated at 28 characters with `…` |
| Background | three-stop diagonal gradient mixed over the session colour |
| Rim | `mix(white, session, 0.55)` at 75 % opacity |
| Chip | 18 × 18, radius 5, session colour, marked with the active action |
| Timing | revealed with the cursor, held 2 s, then fades over 400 ms; approaches by the real pointer re-reveal it |

## Motion

Actions with a screen target glide to it along a cubic path with an arc bulge,
turning the pointer to face its direction of travel. Glide duration is
speed-based and clamped to 180–900 ms. The first reveal starts 140 px up and to
the left of the target so the first move is visible instead of a snap, and every
published sequence reports arrival exactly once — `browser_move` with
`waitForArrival` still waits on that signal.

Reduced motion (`prefers-reduced-motion: reduce`) removes interpolation, the idle
float and the animation loop: the position is set directly and the action paints
its designated still frame.

### Seeing it move

Animation only earns its frames when someone can see them. The overlay checks that
the tab is on screen **and that its window has focus**; when it does, moves glide
as usual. When the window is unfocused, hidden, or in reduced motion, the pointer
is placed directly at its target instead of being flown: nothing is animated, no
animation frames are spent at all, and it is already in the right place the moment
anyone looks. Arrival is reported exactly once either way, so a waiter never
hangs.

Losing focus stops every running animation immediately. Regaining it brings the
label back so the session is identifiable, without moving a pointer that is
already on its target.

Agents never take focus: the runtime activates a tab only when a caller asks, and
`browser_run` has no option that brings a window forward. Background automation
stays background automation.

## Adaptations

Kept deliberately, and reviewed as part of the design:

- SVG strokes instead of a Skia raster. The source glow intensities are
  rasterizer values rather than alphas, so they are scaled into per-stroke
  opacity to reproduce the same soft halo without compositing into a solid blob.
- The cue sits under the pointer, matching the source layer order.
- Cua renders two chips (delivery and target). Browser automation has no
  delivery/target split, so one chip carries the active action instead.
- Reduced motion comes from the media query rather than a driver setting.
- A system font stack is used instead of shipping Inter, so no font licence file
  is needed.

## Verification

`node scripts/verify-cursor.js` loads the built content scripts into a real page
and checks host isolation and layout safety, hotspot accuracy at the reported
coordinate, the per-session palette, label hold and truncation, observed glide
motion, six action animations, the arrival protocol and reduced motion. It also
writes stills to `reports/cursor-reference-*.png`.

Those stills can be compared with the source artwork exported from a theme
artifact:

```sh
cua-driver cursor-theme preview cua.default.cua-theme --output ./preview
```

The values in this document were taken from the Cua Driver source
(`assets/build_default_theme.py`, `src/theme.rs`, `src/session_badge.rs`,
`src/cursor.rs`), not from its rendered output.
