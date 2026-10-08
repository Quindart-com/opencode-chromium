---
name: OpenCode Browser Plugin
description: A compact professional operating panel for local browser automation.
colors:
  bg: "#f4f7fb"
  surface: "#ffffff"
  surface-raised: "#fbfdff"
  surface-border: "#d8e2f0"
  surface-border-strong: "#bdcce0"
  text: "#111b2d"
  text-muted: "#53657e"
  text-faint: "#596c87"
  accent: "#3f63df"
  accent-hover: "#3b5ed8"
  accent-soft: "#e7edff"
  accent-border: "#aebfff"
  primary-text: "#ffffff"
  ok: "#116d4e"
  ok-ink: "#ffffff"
  ok-soft: "#e6f8f0"
  ok-border: "#9dd9bd"
  warn: "#a86b00"
  warn-soft: "#fff6df"
  warn-border: "#e8c778"
  bad: "#b93855"
  bad-ink: "#ffffff"
  bad-soft: "#fff0f3"
  bad-border: "#edb2bf"
  input-bg: "#f8faff"
  button-bg: "#eef3fb"
  button-hover: "#e4ebf7"
  button-border: "#c7d4e6"
  disabled-bg: "#e9eef6"
  disabled-text: "#8190a5"
  disabled-primary-bg: "#b4c0e5"
  disabled-primary-text: "#526488"
  dark-bg: "#090f1d"
  dark-surface: "#121c2e"
  dark-surface-raised: "#17233a"
  dark-surface-border: "#2a3a56"
  dark-surface-border-strong: "#3b4e70"
  dark-text: "#f4f7ff"
  dark-text-muted: "#adc0dc"
  dark-text-faint: "#7f94b5"
  dark-accent: "#86a6ff"
  dark-accent-hover: "#9ab6ff"
  dark-accent-soft: "#21345f"
  dark-accent-border: "#536fae"
  dark-primary-text: "#09152e"
  dark-ok: "#56e5a8"
  dark-ok-ink: "#062719"
  dark-ok-soft: "#123b32"
  dark-ok-border: "#237557"
  dark-warn: "#ffd17a"
  dark-warn-soft: "#46361f"
  dark-warn-border: "#8e6e39"
  dark-bad: "#ff92a7"
  dark-bad-ink: "#2c0711"
  dark-bad-soft: "#472432"
  dark-bad-border: "#8f465b"
  dark-input-bg: "#0c1526"
  dark-button-bg: "#1a2942"
  dark-button-hover: "#223453"
  dark-button-border: "#3a4f72"
  dark-disabled-bg: "#18243a"
  dark-disabled-text: "#8b9dbb"
  dark-disabled-primary-bg: "#354a7d"
  dark-disabled-primary-text: "#c2d0f1"
typography:
  headline:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "17px"
    fontWeight: 750
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  supporting:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11.5px"
    fontWeight: 650
    lineHeight: 1.45
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace'
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.45
rounded:
  tab: "8px"
  control: "9px"
  inset: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  tight: "4px"
  compact: "8px"
  row: "10px"
  section: "12px"
  inset: "14px"
  comfortable: "16px"
  disclosure: "18px"
  dialog: "24px"
components:
  button-default:
    backgroundColor: "{colors.button-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "36px"
  button-save:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "42px"
  button-success:
    backgroundColor: "{colors.ok}"
    textColor: "{colors.ok-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary:
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-secondary:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-danger:
    backgroundColor: "{colors.bad-soft}"
    textColor: "{colors.bad}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  field:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "36px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "13px"
  tab-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.tab}"
    padding: "8px 10px"
    height: "34px"
  status-connected:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
---

# Design System: OpenCode Browser Plugin

## Overview

**Creative North Star: "The Compact Operating Panel"**

The compact professional operating panel keeps operational information readable through restrained neutral surfaces, the existing blue accent, and system typography. Flat bordered panels and small, consistent controls carry the interface across automatic light and dark themes.

The existing shipping logo remains the identity asset. Sentence-case headings, visible keyboard focus, and progressively disclosed details express the approved direction without decorative imagery.

**Key Characteristics:**

- Neutral bordered surfaces and blue interaction states.
- Compact system typography with sentence-case section headings.
- Automatic light and dark themes.
- Progressive disclosure and visible keyboard focus.

## Colors

Cool neutral surfaces support a clear blue interaction accent and semantic green, amber, and rose status treatments. Frontmatter colors preserve the shipped hex values; `dark-` keys are the paired replacements selected by `prefers-color-scheme: dark`.

### Primary

- **Operating Blue:** `accent` drives save actions, focus outlines, selected model states, and native checkbox accents. `accent-hover`, `accent-soft`, and `accent-border` supply interactive variants. `primary-text` supplies theme-aware contrast on filled accent controls.

### Neutral

- **Panel Ground:** `bg` surrounds panels; `surface` holds the main content and `surface-raised` supports subtle hover and status surfaces.
- **Readable Ink:** `text` carries headings and values; `text-muted` carries supporting copy; `text-faint` supports secondary annotations and placeholders.
- **Structural Edges:** `surface-border` divides panels and rows; `surface-border-strong` marks input boundaries and selected inset controls.
- **Control Neutrals:** `input-bg`, `button-bg`, `button-hover`, and `button-border` distinguish fields and ordinary actions. Disabled roles use the dedicated disabled tokens.

### Semantic States

- **Connected Green:** `ok` and its ink, soft, and border variants express ready and successful states.
- **Attention Amber:** `warn`, `warn-soft`, and `warn-border` express unknown/reconnecting state and version guidance.
- **Error Rose:** `bad` and its ink, soft, and border variants mark errors and destructive actions.

**The Semantic Theme Rule.** Keep semantic color roles together when the operating-system theme changes; use the shipped custom properties instead of hard-coded component colors.

## Typography

**Body Font:** System UI, with platform and Segoe UI fallbacks.
**Label/Mono Font:** System UI for labels; the shipped UI monospace stack for identifiers.

The type is compact and practical. There is no separate display face. The frontmatter records reused roles; individual signature values remain local to their components.

### Hierarchy

- **Headline:** Application identity; compact, slightly tightened.
- **Title:** Sentence-case card sections. Decision and provider section titles use their established slightly larger (16px) variant.
- **Body:** Base control and content typography; descriptions typically use the smaller supporting role.
- **Supporting:** Metadata and explanatory copy; provider descriptions use their established (12px, 1.6) variant.
- **Label:** Short field and statistic labels. Navigation and buttons use stronger compact text (12.5px, 700).
- **Mono:** Identifiers that benefit from distinct character shapes.
- **Operational emphasis:** The selected decision model uses (20px, 650, 1.3); numerical usage values use tabular numerals.

**The Sentence Case Rule.** Use sentence-case headings for the operating panel; the final card-heading rule supersedes the earlier uppercase declaration.

## Layout

The popup is a single column at its shipped width (380px), minimum width (340px), and maximum width (100vw). Main content uses inset padding (14px) and stacked gaps (12px). Three equal navigation columns use small gaps and inset padding (4px). Standard cards use padding (13px); decision/provider panels use (18px 16px).

View panels are flex columns with gaps (12px); hidden panels do not display. Action rows wrap rather than force fixed columns. Inputs and identity text can shrink with the available width; identifiers and errors wrap anywhere. Expanded memory statistics use two equal columns with horizontal gaps (18px). There are no viewport breakpoint tokens in the shipped stylesheet.

The upload confirmation page reuses the same stylesheet with automatic width, minimum width (300px), centered content capped at (560px), and dialog padding (24px). Its action row wraps with gaps (12px); confirmation actions have minimum height (40px).

## Elevation & Depth

Main surfaces are flat: the shared shadow token is `none`. Borders and surface tone carry hierarchy. Existing control shadows remain local: a soft accent shadow under gradient primary actions, small lift on filled semantic actions, and compact knob/thumb shadows on toggles and range controls. Selected model cards have a thin accent outline. These treatments do not imply floating panel elevation.

Focus uses an accent outline (2px) offset (3px), supplemented on inputs and buttons by a halo (3px) in the theme's translucent focus color. The final selector explicitly covers tabs, button classes, and the quota slider so the solid outline survives component specificity. The sidecar records these CSS treatments.

**The Flat Panel Rule.** Panels use borders and surface tone for separation. Reserve the existing small shadows for controls, selection, and focus.

## Shapes

Panels and navigation containers have gently curved corners; inputs and actions use the smaller control radius. Inset model and selection panels use the inset radius. Status pills, badges, toggles, and tracks use fully rounded silhouettes. Structural borders are thin (1px). Keep the established role-specific radii from the frontmatter.

## Components

### Buttons

Ordinary actions are compact neutral controls with thin borders and the shared control radius. Hover shifts to the button-hover surface and accent border; press moves the control downward (1px). Disabled states replace color and background with the dedicated disabled roles. The provider save action is full width, filled blue, and taller (42px). Upload confirmation uses the existing gradient primary variant. Success and danger treatments stay semantic; memory's stop action uses the established filled-danger variant.

### Chips

Connection pills combine short status text, a circular indicator, and semantic soft surfaces. Model badges identify default, ready, and uncached state; they use pill shapes and smaller compact labels. Never rely on the indicator color alone.

### Cards / Containers

Neutral surface, thin surface border, panel radius, and flat depth form the default container. Advanced local-model settings repeat this language. Version guidance uses the amber soft surface and amber border. Nested cards inside advanced settings remove redundant borders and padding.

### Inputs / Fields

Text fields use the input surface, strong neutral border, and control radius. Hover adopts the accent border. Focus keeps the accent outline and translucent halo. Provider fields use their roomier established variant (42px minimum height, 10px 12px padding, 8px radius). General selects use the inset radius and surface background. Checkbox controls retain native rendering with the accent color.

### Navigation

Overview, Profiles, and Settings occupy equal-width tabs. The active tab has an accent-soft fill, accent border, and text-colored label; inactive labels are muted, and hover uses the raised surface. Keyboard arrows, Home, and End move between tabs with visible focus.

### Disclosure and Statistics

Labelled native disclosure summaries expose detailed usage, memory, and advanced settings on demand. A top divider and spacing separate usage details from the primary status. Expanded statistic rows use restrained dividers and right-aligned tabular numbers. Truthful loading, unavailable, and unreported copy occupy the same component structures.

## Do's and Don'ts

### Do:

- **Do** use the existing semantic custom properties in both themes.
- **Do** keep the shipping logo and neutral panel language.
- **Do** show text with status colors and retain visible keyboard focus.
- **Do** wrap action rows and long identifiers inside their available width.
- **Do** disclose detailed operational values with labelled summaries.

### Don't:

- **Don't** introduce a display font or a decorative image system into this panel.
- **Don't** use color alone to communicate connection or error states.
- **Don't** copy superseded uppercase card-heading styles or legacy fallback colors into new surfaces.