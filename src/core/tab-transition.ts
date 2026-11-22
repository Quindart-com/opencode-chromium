import { record } from "../shared/values.ts";

// Detects sites that react to automation by blanking, redirecting, or closing the
// tab right after an action. Only origins are ever reported, never full URLs.
export type TabTransitionKind = "none" | "navigated" | "blank" | "closed" | "opened";
export interface TabTransition { kind: TabTransitionKind; fromOrigin?: string | null; toOrigin?: string | null }
export interface TabSnapshot { id: number; url: string | null }
export interface TabTransitionResult { transition: TabTransition; suspected: boolean; hostname: string | null }

// Actions where an unprompted redirect to another site is itself suspicious. A click may
// legitimately follow a link to another site, so clicks only count blank and closed tabs.
const CROSS_SITE_SUSPECT = new Set(["type", "press", "fill", "replaceText"]);
export const TRANSITION_ACTIONS = new Set(["click", "doubleClick", "type", "press", "fill", "replaceText"]);

export const PAGE_PROTECTION_WARNING = {
  code: "PAGE_PROTECTION_SUSPECTED",
  uncertain: true,
  message: "The tab closed, went blank, or left the site right after this action. The site may block automation. Do not retry or replay the action; hand the tab back to the user and let them continue, then ask what to do next.",
} as const;

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url === "about:blank") return "about:blank";
  try {
    const parsed = new URL(url);
    return parsed.origin !== "null" ? parsed.origin : `${parsed.protocol}`;
  } catch { return null; }
}

export function hostnameOf(url: string | null | undefined): string | null {
  try { return url ? new URL(url).hostname || null : null; } catch { return null; }
}

function isBlank(url: string | null | undefined) {
  return !url || url === "about:blank" || /^(chrome|edge|brave):\/\/newtab\/?$/.test(url);
}

function site(url: string | null | undefined) {
  const host = hostnameOf(url);
  if (!host) return null;
  return host.split(".").slice(-2).join(".");
}

function withoutHash(url: string | null | undefined) {
  return (url ?? "").split("#")[0];
}

export function snapshotTabs(result: unknown): TabSnapshot[] | null {
  const tabs = record(result).tabs;
  if (!Array.isArray(tabs)) return null;
  return tabs.flatMap(value => {
    const tab = record(value);
    const id = typeof tab.id === "number" ? tab.id : typeof tab.tabId === "number" ? tab.tabId : null;
    return id === null ? [] : [{ id, url: typeof tab.url === "string" ? tab.url : null }];
  });
}

export function classifyTabTransition(action: string, tabId: number, before: TabSnapshot[] | null, after: TabSnapshot[] | null): TabTransitionResult | null {
  const from = before?.find(tab => tab.id === tabId);
  if (!before || !after || !from) return null;
  const to = after.find(tab => tab.id === tabId);
  const fromOrigin = originOf(from.url);
  const hostname = hostnameOf(from.url);
  if (!to) return { transition: { kind: "closed", fromOrigin, toOrigin: null }, suspected: true, hostname };
  const toOrigin = originOf(to.url);
  if (isBlank(to.url) && !isBlank(from.url)) return { transition: { kind: "blank", fromOrigin, toOrigin }, suspected: true, hostname };
  if (withoutHash(to.url) !== withoutHash(from.url)) {
    const crossSite = site(from.url) !== null && site(to.url) !== null && site(from.url) !== site(to.url);
    return { transition: { kind: "navigated", fromOrigin, toOrigin }, suspected: crossSite && CROSS_SITE_SUSPECT.has(action), hostname };
  }
  const known = new Set(before.map(tab => tab.id));
  const opened = after.find(tab => !known.has(tab.id));
  if (opened) return { transition: { kind: "opened", fromOrigin, toOrigin: originOf(opened.url) }, suspected: false, hostname };
  return { transition: { kind: "none" }, suspected: false, hostname };
}
