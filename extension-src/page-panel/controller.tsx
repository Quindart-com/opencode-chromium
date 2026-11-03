import { createRoot,type Root } from "react-dom/client";
import type { Browser,WxtBrowser } from "wxt/browser";
import { record } from "../../src/shared/values.ts";
import PagePanelApp from "./App.tsx";
import type { PagePanelSnapshot,PagePanelView,PagePanelUsage } from "./protocol.ts";
import material from "./material.css?inline";
import { needsSolidMaterial } from "./material-safety.ts";

/** Same-document material; closed Shadow DOM encapsulates styles, not authorization. */
export function installPagePanel(chrome: WxtBrowser) {
  let host: HTMLDivElement | null = null, root: Root | null = null, port: Browser.runtime.Port | null = null;
  let snapshot: PagePanelSnapshot | null = null, unavailable = false, minimized = false;
  let usage: PagePanelUsage = { period: "7d", provider: "current" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let materialFrame = 0;
  let media: MediaQueryList[] = [];
  let pageStyle: MutationObserver | undefined;
  const refreshMaterial = () => { if (!materialFrame) materialFrame = requestAnimationFrame(() => { materialFrame = 0; if (host) render(); }); };
  let previousFocus: HTMLElement | null = null;
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  const stop = () => {
    clearInterval(timer); timer = undefined;
    cancelAnimationFrame(materialFrame); materialFrame = 0; pageStyle?.disconnect(); pageStyle = undefined;
    window.removeEventListener("scroll", refreshMaterial, true);
    for (const query of media) query.removeEventListener("change", refreshMaterial); media = [];
    window.removeEventListener("pagehide", stop); window.removeEventListener("resize", resize);
    window.visualViewport?.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("scroll", resize);
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release);
    const current = port; port = null; current?.disconnect();
    const focused = document.activeElement === host;
    root?.unmount(); root = null;
    host?.remove(); host = null; drag = null;
    if (focused && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };
  const post = (value: object) => { try { port?.postMessage(value); } catch { unavailable = true; render(); } };
  const position = (left: number, top: number) => {
    if (!host) return;
    const viewport = window.visualViewport, minX = viewport?.offsetLeft ?? 0, minY = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const bounds = host.getBoundingClientRect();
    host.style.setProperty("--panel-left", `${Math.max(minX + 8, Math.min(left, minX + width - bounds.width - 8))}px`);
    host.style.setProperty("--panel-top", `${Math.max(minY + 8, Math.min(top, minY + height - Math.min(bounds.height, height - 16) - 8))}px`);
    host.style.setProperty("--panel-right", "auto");
    host.style.setProperty("--panel-height", `${Math.max(80, height - 28)}px`);
    refreshMaterial();
  };
  const resize = () => { const rect = host?.getBoundingClientRect(); if (rect) position(rect.left, rect.top); };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  };
  const release = () => { drag = null; };
  function render() {
    const forcedSolid = !CSS.supports("backdrop-filter", "blur(1px)") || media.slice(1).some(query => query.matches);
    root?.render(<PagePanelApp snapshot={snapshot} unavailable={unavailable} minimized={minimized}
      solid={forcedSolid || !host || needsSolidMaterial(host)} forcedSolid={forcedSolid} layoutChanged={refreshMaterial}
      setUsage={next => { usage = next; snapshot = null; post({ type: "refresh", usage }); render(); }}
      open={(view: PagePanelView) => post({ type: "open", view })} close={() => { post({ type: "close" }); stop(); }}
      minimize={() => { minimized = !minimized; render(); requestAnimationFrame(resize); }}
      move={event => {
        if (event.button !== 0 || !host) return;
        const rect = host.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      nudge={event => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const direction = directions[event.key], rect = host?.getBoundingClientRect();
        if (!direction || !rect) return;
        event.preventDefault(); position(rect.left + direction[0] * 12, rect.top + direction[1] * 12);
      }} />);
  }
  const show = (instance: string) => {
    stop(); snapshot = null; unavailable = false; minimized = false; usage = { period: "7d", provider: "current" };
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    host = document.createElement("div");
    host.id = `opencode-page-panel-${crypto.randomUUID()}`;
    const shadow = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet(); sheet.replaceSync(material); shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Firefox content-script Xrays cannot adopt constructed stylesheets.
      // Keep the fallback inside the same closed root, as WXT's shadow UI does.
      const style = document.createElement("style"); style.textContent = material; shadow.append(style);
    }
    const mount = document.createElement("div"); shadow.append(mount);
    root = createRoot(mount); document.documentElement.append(host);
    host.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); post({ type: "close" }); stop(); } });
    port = chrome.runtime.connect({ name: `page-panel:${instance}` });
    const current = port;
    current.onDisconnect.addListener(() => { if (port === current) stop(); });
    current.onMessage.addListener(value => {
      if (port !== current) return;
      const message = record(value);
      if (message.type === "snapshot") { snapshot = message.data as PagePanelSnapshot; unavailable = false; render(); }
      if (message.type === "unavailable") { unavailable = true; render(); }
      if (message.type === "capture" && host) {
        host.style.setProperty("visibility", message.hidden === true ? "hidden" : "visible", "important");
        if (message.hidden === true && typeof message.id === "string") {
          // Capture only after the compositor has had a chance to consume the hidden state.
          requestAnimationFrame(() => { if (port === current) post({ type: "hidden", id: message.id }); });
        }
      }
    });
    timer = setInterval(() => {
      if (host && !host.isConnected) { post({ type: "close" }); stop(); return; }
      if (!document.hidden && !minimized) post({ type: "refresh", usage });
    }, 5000);
    window.addEventListener("pagehide", stop); window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize); window.visualViewport?.addEventListener("scroll", resize);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release);
    media = ["(prefers-color-scheme: dark)", "(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"].map(query => matchMedia(query));
    for (const query of media) query.addEventListener("change", refreshMaterial);
    window.addEventListener("scroll", refreshMaterial, { capture: true, passive: true });
    pageStyle = new MutationObserver(refreshMaterial);
    pageStyle.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    if (document.body) pageStyle.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    render();
  };
  const listener = (value: unknown, sender: Browser.runtime.MessageSender, respond: (response: unknown) => void) => {
    const message = record(value);
    if (message.type !== "PAGE_PANEL_SHOW" || sender.id !== chrome.runtime.id || sender.tab || typeof message.instance !== "string" || message.instance.length > 100) return false;
    try { show(message.instance); respond({ ok: true }); } catch { stop(); respond({ ok: false }); }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    stop(); chrome.runtime.onMessage.removeListener(listener);
    window.removeEventListener("pagehide", stop); window.removeEventListener("resize", resize);
    window.visualViewport?.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("scroll", resize);
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release);
  };
}
