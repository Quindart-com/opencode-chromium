import { setTimeout as delay } from "node:timers/promises";
import { BrowserRuntimeError } from "../../core/errors.ts";
import { record } from "../../shared/values.ts";
import { LADYBIRD_PROFILE,type LadybirdConfig } from "./config.ts";
import { driverRequest,launchLadybird,WebDriverError,type LadybirdDriver } from "./driver.ts";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export interface LadybirdTab {
  id: number;
  handle: string;
  url: string;
  title: string;
  refs: Map<number, string>;
  elementRefs: Map<string, number>;
}

export function publicLadybirdTab(tab: LadybirdTab) {
  return { id: tab.id, tabId: tab.id, url: tab.url, title: tab.title, profileId: LADYBIRD_PROFILE };
}

export function elementId(value: unknown) {
  const id = record(value)[ELEMENT_KEY];
  return typeof id === "string" && id.length <= 512 ? id : null;
}

export function elementValue(id: string) { return { [ELEMENT_KEY]: id }; }

export function staleLadybirdRef() {
  return new BrowserRuntimeError("The Ladybird element reference is stale. Observe the tab again.", { code: "STALE_TARGET" });
}

export class LadybirdSession {
  #driver: LadybirdDriver | null = null;
  #endpoint = "";
  #session = "";
  #initialHandle = "";
  #activeHandle = "";
  #tail = Promise.resolve();
  #closing = false;
  #closed: Promise<void> | null = null;
  readonly #allocateId: () => number;
  deadlineAt?: number;
  readonly tabs = new Map<number, LadybirdTab>();
  selected: number | null = null;
  version: string | null = null;

  constructor(allocateId: () => number) { this.#allocateId = allocateId; }

  async serial<T>(work: () => Promise<T>) {
    const pending = this.#tail.then(async () => {
      if (this.#closing) throw new BrowserRuntimeError("The Ladybird session has closed.", { code: "LADYBIRD_DISCONNECTED" });
      try { return await work(); }
      catch (error) {
        if (error instanceof BrowserRuntimeError && (error.uncertain || ["LADYBIRD_DISCONNECTED", "TIMEOUT"].includes(error.code)) ||
          error instanceof WebDriverError && error.webdriverCode === "invalid session id") await this.close();
        throw error;
      }
    });
    this.#tail = pending.then(() => {}, () => {});
    return pending;
  }

  async start(config: LadybirdConfig) {
    const driver = this.#driver = launchLadybird(config);
    try {
      this.#endpoint = await driver.endpoint();
      for (let attempt = 0; ; attempt += 1) {
        try { await driverRequest(this.#endpoint, "GET", "/status", undefined, 1000); break; }
        catch (error) {
          if (attempt === 15 || this.#closing || record(error).code !== "LADYBIRD_DISCONNECTED") throw error;
          await delay(150);
        }
      }
      if (this.#closing) throw new Error("Ladybird stopped before creating a session.");
      // The pinned alpha can stall Element Click when using the eager strategy.
      const value = record(await driverRequest(this.#endpoint, "POST", "/session", {
        capabilities: { alwaysMatch: { browserName: "ladybird", "ladybird:headless": true, pageLoadStrategy: "normal", unhandledPromptBehavior: "ignore" } },
      }, 20000));
      if (typeof value.sessionId !== "string" || !value.sessionId) throw new Error("Ladybird WebDriver did not return a session ID.");
      this.#session = "/session/" + encodeURIComponent(value.sessionId);
      const capabilities = record(value.capabilities);
      if (capabilities.browserName !== "ladybird") throw new Error("WebDriver did not identify its browser as Ladybird.");
      this.version = typeof capabilities.browserVersion === "string" ? capabilities.browserVersion : null;
      const handle = await this.request("GET", "/window");
      if (typeof handle !== "string" || !handle) throw new Error("Ladybird WebDriver did not open an initial tab.");
      this.#initialHandle = handle;
      this.#activeHandle = handle;
    } catch (error) {
      const log = driver.startupLog();
      await this.close();
      if (log && error instanceof Error) error.message += "\n" + log;
      throw error;
    }
  }

  request(method: string, target: string, body?: object, timeoutMs?: number) {
    if (this.#closing || !this.#session) throw new BrowserRuntimeError("The Ladybird session has closed.", { code: "LADYBIRD_DISCONNECTED" });
    const remaining = (this.deadlineAt ?? Infinity) - Date.now();
    if (remaining <= 0) throw new BrowserRuntimeError("The Ladybird operation deadline expired.", { code: "TIMEOUT" });
    return driverRequest(this.#endpoint, method, this.#session + target, body, Math.min(remaining, timeoutMs ?? 10000));
  }

  evaluate(script: string, args: unknown[] = []) {
    return this.request("POST", "/execute/sync", { script, args });
  }

  async createTab() {
    const handle = this.#initialHandle || record(await this.request("POST", "/window/new", { type: "tab" })).handle;
    if (typeof handle !== "string" || !handle) throw new Error("Ladybird WebDriver did not return a new tab handle.");
    this.#initialHandle = "";
    if (this.#activeHandle !== handle) {
      await this.request("POST", "/window", { handle });
      this.#activeHandle = handle;
    }
    const id = this.#allocateId();
    const tab = { id, handle, url: "about:blank", title: "", refs: new Map<number, string>(), elementRefs: new Map<string, number>() };
    this.tabs.set(id, tab);
    this.selected = id;
    return publicLadybirdTab(tab);
  }

  async switchTab(id: unknown) {
    const tab = typeof id === "number" ? this.tabs.get(id) : undefined;
    if (!tab) throw new BrowserRuntimeError("That tab does not belong to this Ladybird session.", { code: "TAB_NOT_OWNED" });
    try {
      if (this.#activeHandle !== tab.handle) {
        await this.request("POST", "/window", { handle: tab.handle });
        this.#activeHandle = tab.handle;
      }
    }
    catch (error) {
      if (!(error instanceof WebDriverError) || error.webdriverCode !== "no such window") throw error;
      this.tabs.delete(tab.id);
      if (this.selected === tab.id) this.selected = null;
      throw new BrowserRuntimeError("The Ladybird tab has closed.", { code: "TAB_NOT_OWNED" });
    }
    this.selected = tab.id;
    return tab;
  }

  async refresh(tab: LadybirdTab) {
    const url = await this.request("GET", "/url");
    const title = await this.request("GET", "/title");
    if (typeof url === "string") tab.url = url;
    if (typeof title === "string") tab.title = title;
    return publicLadybirdTab(tab);
  }

  async closeTab(tab: LadybirdTab) {
    await this.request("DELETE", "/window");
    this.#activeHandle = "";
    this.tabs.delete(tab.id);
    this.selected = null;
    if (!this.tabs.size) await this.close();
  }

  elementFor(tab: LadybirdTab, ref: number) {
    const id = tab.refs.get(ref);
    if (!id) throw staleLadybirdRef();
    return id;
  }

  remember(tab: LadybirdTab, id: string) {
    const known = tab.elementRefs.get(id);
    if (known !== undefined) return known;
    if (tab.refs.size === 1000) {
      const oldest = tab.refs.keys().next().value!;
      tab.elementRefs.delete(tab.refs.get(oldest)!);
      tab.refs.delete(oldest);
    }
    const ref = this.#allocateId();
    tab.refs.set(ref, id);
    tab.elementRefs.set(id, ref);
    return ref;
  }

  close() {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#closed = (async () => {
      try {
        if (this.#session) await driverRequest(this.#endpoint, "DELETE", this.#session, undefined, 2000).catch(() => {});
      } finally {
        await this.#driver?.close();
        this.tabs.clear();
        this.selected = null;
        this.#session = "";
      }
    })();
    return this.#closed;
  }

  get closing() { return this.#closing; }
}
