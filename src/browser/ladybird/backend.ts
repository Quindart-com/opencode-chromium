import { setTimeout as delay } from "node:timers/promises";
import { BrowserRuntimeError } from "../../core/errors.ts";
import type { BrowserContext } from "../../core/tool-definition.ts";
import { record } from "../../shared/values.ts";
import { parseKeyPress } from "../keyboard.ts";
import { pageStateExpression } from "../operations/page-state.ts";
import { LADYBIRD_PROFILE,readLadybirdConfig } from "./config.ts";
import { ladybirdNodeId,observeLadybird,renderLadybirdView,searchLadybird } from "./observation.ts";
import { elementId,elementValue,LadybirdSession,publicLadybirdTab,staleLadybirdRef,type LadybirdTab } from "./session.ts";

const IDLE_MS = 10 * 60 * 1000;
const SUPPORTED_TAB_OPERATIONS = new Set([
  "browser_get_tab", "browser_navigate", "browser_reload", "browser_back", "browser_forward", "browser_close_tab",
  "browser_read_view", "browser_dom_snapshot", "browser_dom_quiet", "browser_page_search", "browser_page_inspect",
  "browser_ref_point", "browser_locator_count", "browser_locator_text", "browser_screenshot", "browser_handle_dialog",
  "browser_locator_click", "browser_dom_click", "browser_locator_fill", "browser_dom_type", "browser_type",
  "browser_keypress", "browser_scroll",
]);
const WEBDRIVER_KEYS: Record<string, string> = {
  Backspace: "\uE003", Tab: "\uE004", Enter: "\uE007", Shift: "\uE008", Control: "\uE009", Alt: "\uE00A",
  Escape: "\uE00C", PageUp: "\uE00E", PageDown: "\uE00F", End: "\uE010", Home: "\uE011",
  ArrowLeft: "\uE012", ArrowUp: "\uE013", ArrowRight: "\uE014", ArrowDown: "\uE015",
  Insert: "\uE016", Delete: "\uE017", Meta: "\uE03D",
};

export function unsupportedLadybird(feature: string) {
  return new BrowserRuntimeError("Ladybird (Experimental) does not support " + feature + ".", { code: "UNSUPPORTED_CAPABILITY" });
}

export function assertLadybirdPolicy(context: BrowserContext) {
  if (context.urlPolicy?.allowedOrigins.length || context.urlPolicy?.blockedOrigins.length) {
    throw unsupportedLadybird("sessions with origin rules because WebDriver cannot enforce them across redirects");
  }
}

function checkDeadline(context: BrowserContext) {
  if (context.deadlineAt && Date.now() >= context.deadlineAt) {
    throw new BrowserRuntimeError("The Ladybird operation deadline expired.", { code: "TIMEOUT" });
  }
}

async function resolveElement(session: LadybirdSession, tab: LadybirdTab, args: Record<string, unknown>) {
  const ref = /^ladybird:(\d+)$/.exec(String(args.nodeId ?? ""));
  if (args.nodeId !== undefined && !ref) throw staleLadybirdRef();
  if (ref) return session.elementFor(tab, Number(ref[1]));
  if (typeof args.selector !== "string") {
    const active = elementId(await session.request("GET", "/element/active"));
    if (active) return active;
    throw new BrowserRuntimeError("No active element in this Ladybird tab.", { code: "TARGET_NOT_FOUND" });
  }
  const matches = await session.request("POST", "/elements", { using: "css selector", value: args.selector });
  if (!Array.isArray(matches) || matches.length === 0) throw new BrowserRuntimeError("No element matches the selector.", { code: "TARGET_NOT_FOUND" });
  if (matches.length !== 1) throw new BrowserRuntimeError("The selector matches multiple elements. Use a reference or narrow the selector.", { code: "AMBIGUOUS_TARGET" });
  const match = elementId(matches[0]);
  if (!match) throw new Error("Ladybird WebDriver returned an invalid element reference.");
  return match;
}

async function guardFileInput(session: LadybirdSession, id: string) {
  const safe = await session.evaluate(
    "const node = arguments[0]; const label = node.closest('label'); return node.type !== 'file' && label?.control?.type !== 'file';", [elementValue(id)],
  );
  if (safe !== true) throw unsupportedLadybird("opening a file picker or uploading files");
}

async function elementInput(session: LadybirdSession, tab: LadybirdTab, method: string, args: Record<string, unknown>) {
  const id = await resolveElement(session, tab, args);
  const endpoint = "/element/" + encodeURIComponent(id);
  await guardFileInput(session, id);
  if (method.endsWith("_click")) {
    await session.request("POST", endpoint + "/click", {});
    return { clicked: true, inputRoute: "webdriver" };
  }
  if (args.mode === "focus") {
    await session.evaluate("arguments[0].focus();", [elementValue(id)]);
    return { focused: true, inputRoute: "webdriver" };
  }
  const text = String(args.value ?? args.text ?? "");
  if (args.mode === "replace") await session.request("POST", endpoint + "/clear", {});
  if (text) await session.request("POST", endpoint + "/value", { text });
  return { typed: text.length, inputRoute: "webdriver" };
}

async function keypress(session: LadybirdSession, tab: LadybirdTab, args: Record<string, unknown>) {
  const { modifiers, primary } = parseKeyPress(String(args.key));
  const key = WEBDRIVER_KEYS[primary.key] ?? primary.key;
  if ([...key].length !== 1) throw unsupportedLadybird("the " + primary.key + " key");
  const id = await resolveElement(session, tab, args);
  await guardFileInput(session, id);
  if (args.nodeId || args.selector) await session.evaluate("arguments[0].focus();", [elementValue(id)]);
  const values = [...modifiers.map(modifier => WEBDRIVER_KEYS[modifier]!), key];
  const actions = [...values.map(value => ({ type: "keyDown", value })), ...values.reverse().map(value => ({ type: "keyUp", value }))];
  await session.request("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
  return { key: args.key, inputRoute: "webdriver" };
}

async function tabOperation(session: LadybirdSession, tab: LadybirdTab, name: string, args: Record<string, unknown>, context: BrowserContext) {
  switch (name) {
    case "browser_get_tab": return session.refresh(tab);
    case "browser_navigate": {
      const url = String(args.url);
      if (!/^https?:\/\//i.test(url) && url !== "about:blank") throw unsupportedLadybird("navigation outside HTTP(S) or about:blank");
      const timeoutMs = Math.max(1, Math.min(Number(args.timeoutMs ?? 15000), (context.deadlineAt ?? Infinity) - Date.now()));
      await session.request("POST", "/timeouts", { pageLoad: timeoutMs });
      await session.request("POST", "/url", { url }, timeoutMs + 250);
      if (args.waitUntil === "load") {
        const deadline = Date.now() + timeoutMs;
        while (await session.evaluate("return document.readyState;") !== "complete") {
          if (Date.now() >= deadline) throw new BrowserRuntimeError("The Ladybird page did not finish loading.", { code: "TIMEOUT" });
          await delay(50);
        }
      }
      return session.refresh(tab);
    }
    case "browser_reload":
    case "browser_back":
    case "browser_forward": {
      if (args.bypassCache) throw unsupportedLadybird("bypassing the cache");
      await session.request("POST", name === "browser_reload" ? "/refresh" : name === "browser_back" ? "/back" : "/forward", {});
      return session.refresh(tab);
    }
    case "browser_close_tab": {
      await session.closeTab(tab);
      return { closed: true, tabId: tab.id };
    }
    case "browser_dom_quiet": return session.evaluate("return " + pageStateExpression() + ";");
    case "browser_dom_snapshot": {
      const { entries, text: _text, ...page } = await observeLadybird(session, tab, "viewport", true);
      return { ...page, nodes: entries };
    }
    case "browser_read_view": {
      const page = await observeLadybird(session, tab, args.scope === "page" ? "page" : "viewport");
      return { url: page.url, title: page.title, view: renderLadybirdView(page, String(args.query ?? ""), Math.min(Number(args.maxChars), 16000), args.scope === "page") };
    }
    case "browser_page_search": {
      if (!["auto", "lexical"].includes(String(args.mode))) throw unsupportedLadybird("semantic search");
      if (args.selector || args.containerNodeId || args.clip || args.scope === "focused") throw unsupportedLadybird("scoped search");
      const page = await observeLadybird(session, tab, args.scope === "viewport" ? "viewport" : "page");
      const query = String(args.query);
      return { url: page.url, title: page.title, query, mode: "lexical",
        results: searchLadybird(page.entries, query).slice(0, Math.min(100, Number(args.maxResults))) };
    }
    case "browser_ref_point": {
      const ref = Number(args.ref);
      const id = session.elementFor(tab, ref);
      await session.evaluate("return arguments[0].isConnected;", [elementValue(id)]);
      return { ref, nodeId: ladybirdNodeId(ref) };
    }
    case "browser_locator_count": {
      const result = await session.request("POST", "/elements", { using: "css selector", value: args.selector });
      return { count: Array.isArray(result) ? result.length : 0 };
    }
    case "browser_locator_text": {
      const id = await resolveElement(session, tab, args);
      const text = await session.evaluate("const el = arguments[0]; return String(el.innerText ?? el.textContent ?? '').slice(0, 12000);", [elementValue(id)]);
      return { text };
    }
    case "browser_page_inspect": {
      const id = args.selector || args.nodeId ? await resolveElement(session, tab, args) : null;
      return session.evaluate("const el = arguments[0] ?? document.body; return {url: location.href, title: document.title, node: {tagName: el?.localName, role: el?.getAttribute('role'), text: String(el?.innerText ?? '').slice(0, arguments[1])}};",
        [id ? elementValue(id) : null, args.maxText]);
    }
    case "browser_dom_click":
    case "browser_locator_click":
    case "browser_dom_type":
    case "browser_locator_fill":
    case "browser_type": return elementInput(session, tab, name, args);
    case "browser_keypress": return keypress(session, tab, args);
    case "browser_scroll": {
      if (args.x !== undefined || args.y !== undefined) throw unsupportedLadybird("scrolling an element by screen coordinates");
      return session.evaluate("scrollBy(arguments[0], arguments[1]); return { x: scrollX, y: scrollY };", [args.scrollX, args.scrollY]);
    }
    case "browser_handle_dialog": {
      if (args.promptText !== undefined) await session.request("POST", "/alert/text", { text: args.promptText });
      await session.request("POST", args.value === "accept" ? "/alert/accept" : "/alert/dismiss", {});
      return { handled: true };
    }
    case "browser_screenshot": {
      if (args.fullPage || args.clip || args.format !== "png") throw unsupportedLadybird("screenshots other than viewport PNG");
      const base64 = await session.request("GET", "/screenshot", undefined, Math.min(Number(args.timeoutMs), 30000));
      if (typeof base64 !== "string" || base64.length > 4_000_000 || !base64.startsWith("iVBORw0KGgo")) {
        throw new BrowserRuntimeError("Ladybird returned an invalid or oversized PNG screenshot.", { code: "LADYBIRD_SCREENSHOT_FAILED" });
      }
      return { mimeType: "image/png", base64, fullPage: false, bytes: Buffer.from(base64, "base64").length };
    }
    default: throw unsupportedLadybird(name);
  }
}

export class LadybirdBackend {
  readonly #sessions = new Map<string, { controller: LadybirdSession; starting: Promise<void>; timer?: ReturnType<typeof setTimeout>; pending: number }>();
  #nextId = 0;

  async execute(sessionId: string, name: string, args: Record<string, unknown>, context: BrowserContext) {
    assertLadybirdPolicy(context);
    if (context.frameId && context.frameId !== "main") throw unsupportedLadybird("frame targeting");
    if (name === "browser_turn_end" || name === "browser_name_session") return {};
    if (name === "browser_list_tabs" && args.scope === "user") return { tabs: [] };
    if (name === "browser_status" || name === "browser_capabilities") return { engine: "ladybird", experimental: true };
    if (name !== "browser_new_tab" && name !== "browser_finalize" && name !== "browser_list_tabs" &&
      name !== "browser_selected_tab" && !SUPPORTED_TAB_OPERATIONS.has(name)) throw unsupportedLadybird(name);
    let entry = this.#sessions.get(sessionId);
    if (entry?.controller.closing) {
      const closing = entry;
      await closing.controller.close();
      entry = this.#sessions.get(sessionId);
      if (entry === closing) { this.#sessions.delete(sessionId); entry = undefined; }
    }
    if (!entry && name === "browser_new_tab") {
      const config = readLadybirdConfig();
      if (!config) throw new BrowserRuntimeError("Configure Ladybird's WebDriver with opencode-chromium ladybird configure.", { code: "PROFILE_DISCONNECTED" });
      const controller = new LadybirdSession(() => ++this.#nextId);
      const starting = controller.start(config);
      entry = { controller, starting, pending: 0 };
      this.#sessions.set(sessionId, entry);
    }
    const finalized = { partial: false, profileId: LADYBIRD_PROFILE, closed: true, tabs: [] };
    if (!entry) {
      if (name === "browser_finalize") return finalized;
      if (name === "browser_list_tabs") return { tabs: [] };
      if (name === "browser_selected_tab") return null;
      throw new BrowserRuntimeError("No managed Ladybird tab is active. Create a new tab first.", { code: "TAB_NOT_OWNED" });
    }
    const { controller } = entry;
    clearTimeout(entry.timer);
    entry.pending += 1;
    try {
      await entry.starting;
      return await controller.serial(async () => {
        checkDeadline(context);
        if (name === "browser_list_tabs") return { tabs: [...controller.tabs.values()].map(publicLadybirdTab) };
        if (name === "browser_selected_tab") {
          const selected = controller.tabs.get(controller.selected ?? -1);
          return selected ? publicLadybirdTab(selected) : null;
        }
        if (name === "browser_finalize") {
          const keep = Array.isArray(args.keep) ? args.keep as unknown[] : [];
          if (keep.some(item => record(item).status === "handoff")) throw unsupportedLadybird("live tab handoff");
          const tabs = [...controller.tabs.values()].map(publicLadybirdTab);
          await controller.close();
          return { ...finalized, tabs };
        }
        controller.deadlineAt = context.deadlineAt;
        try {
          if (name === "browser_new_tab") return await controller.createTab();
          return await tabOperation(controller, await controller.switchTab(args.tabId), name, args, context);
        } finally { controller.deadlineAt = undefined; }
      });
    } finally {
      entry.pending -= 1;
      if (this.#sessions.get(sessionId) === entry && !entry.pending) {
        if (controller.closing) this.#sessions.delete(sessionId);
        else {
          entry.timer = setTimeout(() => { this.#sessions.delete(sessionId); void controller.close(); }, IDLE_MS);
          entry.timer.unref();
        }
      }
    }
  }

  async close() {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(entries.map(({ controller, timer }) => { clearTimeout(timer); return controller.close(); }));
  }
}
