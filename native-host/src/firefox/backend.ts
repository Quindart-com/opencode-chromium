import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Commands,Event,Input,Script } from "webdriver-bidi-protocol";
import WebSocket from "ws";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import type { ProfileRegistration } from "../../../src/shared/profile-registry.ts";
import { isRecord,record } from "../../../src/shared/values.ts";
import { resolveFirefoxFrame,translateFirefoxPoint,verifyFirefoxContext } from "./frame-operations.ts";
import { bridgedFrameTree } from "./frames.ts";
import type { BidiParams,BidiSend } from "./protocol.ts";
type EventSink = (tabId: number, method: string, params: Record<string, unknown>) => void;
type RemoteObject = { context: string; handle?: string; sharedId?: string };
type NormalizedEvaluation = { result?: { type: string; subtype?: string; objectId?: string; value?: unknown }; exceptionDetails?: { text: string } };
const text = (value: unknown, name: string): string => { if (typeof value !== "string") throw new TypeError("Expected " + name); return value; };
const number = (value: unknown, name: string, fallback?: number): number => { const resolved = value ?? fallback; if (typeof resolved !== "number" || !Number.isFinite(resolved)) throw new TypeError("Expected numeric " + name); return resolved; };

export function localValue(value: unknown): Script.LocalValue {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") return { type: "number", value: Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value };
  if (Array.isArray(value)) return { type: "array", value: value.map(localValue) };
  if (isRecord(value)) return { type: "object", value: Object.entries(value).map(([key, item]) => [key, localValue(item)]) };
  throw new TypeError("Unsupported Firefox script argument");
}

export function firefoxConfigPath(profileId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileId ?? "")) throw new Error("Invalid Firefox profile ID");
  const base = process.env.OPENCODE_BROWSER_RUNTIME_DIR ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser") : path.join(os.homedir(), ".config", "opencode", "browser"));
  return path.join(base, "firefox", `${profileId}.json`);
}
export function validateEndpoint(value: unknown) {
  const u = new URL(text(value, "Firefox endpoint"));
  if (u.protocol !== "ws:" || u.hostname !== "127.0.0.1" || !u.port || u.username || u.password || u.pathname !== "/session" || u.search || u.hash) throw new Error("Firefox endpoint must be ws://127.0.0.1:PORT/session");
  return u.href;
}
export function remoteValue(v: Script.RemoteValue | undefined): unknown {
  if (!v || v.type === "undefined") return undefined;
  if (v.type === "null") return null;
  if (v.type === "array") return v.value?.map(remoteValue);
  if (v.type === "object") return v.value ? Object.fromEntries(v.value.map(([key, item]) => [typeof key === "string" ? key : String(remoteValue(key)), remoteValue(item)])) : undefined;
  return "value" in v ? v.value : undefined;
}
const keys: Readonly<Record<string, string>> = { Enter: "\uE007", Tab: "\uE004", Escape: "\uE00C", Backspace: "\uE003", Delete: "\uE017", ArrowLeft: "\uE012", ArrowRight: "\uE014", ArrowUp: "\uE013", ArrowDown: "\uE015", Home: "\uE011", End: "\uE010", Control: "\uE009", Shift: "\uE008", Alt: "\uE00A", Meta: "\uE03D" };

const fileGuard = "function(){if(globalThis.__opencodeFileGuard)return;globalThis.__opencodeFileGuard=e=>{if(e.composedPath().some(n=>n instanceof HTMLInputElement&&n.type==='file'))e.preventDefault()};document.addEventListener('click',globalThis.__opencodeFileGuard,true)}";
// Internal page-command compatibility adapter. Firefox never receives CDP.
export class FirefoxBackend {
  readonly frameTabs = new Map<string, number>();
  readonly dialogs = new Map<number, string>();
  readonly endpoint: string | undefined;
  readonly WebSocketImpl: typeof WebSocket;
  readonly onEvent: EventSink;
  readonly pending: Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>;
  readonly contexts: Map<number, string>;
  readonly objects: Map<string, RemoteObject>;
  readonly preloads: Map<number, string>;
  readonly environmentPreloads: Map<number, string[]>;
  nextId: number;
  downloadCapabilities: { started: boolean; completed: boolean };
  ready: Promise<void> | null = null;
  socket: WebSocket | null = null;
  sessionId: string | null = null;
  browserVersion: string | undefined;

  constructor({ endpoint, WebSocketImpl = WebSocket, onEvent = () => {} }: { endpoint?: string; WebSocketImpl?: typeof WebSocket; onEvent?: EventSink } = {}) {
    this.endpoint = endpoint; this.WebSocketImpl = WebSocketImpl; this.onEvent = onEvent;
    this.pending = new Map(); this.contexts = new Map(); this.objects = new Map(); this.preloads = new Map(); this.environmentPreloads = new Map(); this.nextId = 1;
    this.downloadCapabilities = { started: false, completed: false };
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const s = this.socket = new this.WebSocketImpl(validateEndpoint(this.endpoint));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { s.close(); reject(new Error("Firefox remote connection timed out")); }, 5000);
        s.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        s.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Firefox remote connection unavailable")); }, { once: true });
      });
      s.addEventListener("message", event => {
        if (this.socket !== s) return;
        let m: Record<string, unknown>; try { m = record((JSON.parse(String(event.data)) as unknown)); } catch { return; }
        const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
        if (p) { clearTimeout(p.timer); if (typeof m.id === "number") this.pending.delete(m.id); if (m.type === "error") p.reject(Object.assign(new Error(`Firefox ${m.error}: ${m.message}`), /no such (node|handle|frame)/.test(String(m.error)) ? { code: "STALE_TARGET", uncertain: false, executionState: "not_started" } : {})); else p.resolve(m.result ?? {}); }
        else if (m.type === "event" && typeof m.method === "string" && isRecord(m.params)) this.event(m as unknown as Event);
      });
      s.addEventListener("close", () => {
        if (this.socket !== s) return;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Firefox connection closed")); }
        this.pending.clear(); this.contexts.clear(); this.frameTabs.clear(); this.dialogs.clear(); this.objects.clear(); this.preloads.clear(); this.environmentPreloads.clear(); this.sessionId = null; this.ready = null;
      });
      const session = await this.send("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: "ignore" } } } });
      this.sessionId = session.sessionId;
      const version = Number.parseInt(session.capabilities?.browserVersion ?? "0", 10);
      if (version < 140) throw new Error("Firefox 140 or later is required; update the selected browser before configuring automation");
      this.browserVersion = session.capabilities.browserVersion;
      await this.send("session.subscribe", { events: ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError", "browsingContext.userPromptOpened", "browsingContext.userPromptClosed", "browsingContext.contextDestroyed"] });
      // These events arrived after the minimum supported Firefox version. Probe
      // individually so unavailable download completion never breaks browsing.
      for (const [capability, event] of [["started", "browsingContext.downloadWillBegin"], ["completed", "browsingContext.downloadEnd"]] as const) {
        try {
          await this.send("session.subscribe", { events: [event] });
          this.downloadCapabilities[capability] = true;
        } catch (error) {
          if (!/invalid argument|unknown command|unsupported operation/i.test(error instanceof Error ? error.message : String(error))) throw error;
          this.downloadCapabilities[capability] = false;
        }
      }
    })();
    try { await this.ready; } catch (e) { await this.close(); this.ready = null; throw e; }
  }
  send<K extends keyof Commands>(method: K, params: BidiParams<K>, timeoutMs = 10000): Promise<Commands[K]["returnType"]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Firefox connection is closed; reconnect the selected profile"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Firefox command timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    }).then(value => value as Commands[K]["returnType"]);
  }
  async attach(tabId: number, marker: string, deadlineAt = Date.now() + 10000) {
    if (!Number.isInteger(tabId) || !/^[a-f0-9]{32}$/.test(marker ?? "")) throw new Error("Invalid Firefox tab bridge");
    await beforeDeadline(() => this.connect(), deadlineAt, { tabId, phase: "Firefox connection", executionState: "not_started" });
    const send: BidiSend = (method, params) => beforeDeadline(() => this.send(method, params, Math.max(1, deadlineAt - Date.now() + 2000)), deadlineAt, { tabId, phase: "Firefox attach", method, executionState: "not_started" }, result => {
      if (method === "script.addPreloadScript" && typeof record(result).script === "string") void this.send("script.removePreloadScript", { script: String(record(result).script) }, 2000).catch(() => {});
    });
    const { contexts } = await send("browsingContext.getTree", {});
    const matches: string[] = [];
    for (const c of contexts) {
      try {
        const r = await send("script.evaluate", { expression: "document.documentElement?.getAttribute('data-opencode-bidi-bridge')", target: { context: c.context }, awaitPromise: false });
        if (r.type === "success" && remoteValue(r.result) === marker) matches.push(c.context);
      } catch { /* Ignore unrelated privileged tabs. */ }
    }
    if (matches.length !== 1) throw new Error("Firefox tab/profile bridge could not be verified; check the configured profile and port");
    const context = matches[0];
    if (!context) throw new Error("Firefox bridge is unavailable");
    await beforeDeadline(() => {}, deadlineAt, { tabId, phase: "Firefox ownership", executionState: "not_started" });
    this.contexts.set(tabId, context);
    let preload: string | undefined;
    try {
      const result = await send("script.addPreloadScript", { functionDeclaration: fileGuard, contexts: [context] });
      preload = result.script;
      this.preloads.set(tabId, result.script);
      await send("script.callFunction", { functionDeclaration: fileGuard, target: { context }, awaitPromise: false });
    } catch (error) {
      this.contexts.delete(tabId);
      if (preload && this.preloads.get(tabId) === preload) {
        this.preloads.delete(tabId);
        void this.send("script.removePreloadScript", { script: preload }, 1000).catch(() => {});
      }
      throw error;
    }
    return {};
  }
  event(m: Event): void {
    const context = "context" in m.params ? m.params.context : "source" in m.params ? m.params.source.context : null;
    const tabId = [...this.contexts].find(([, c]) => c === context)?.[0] ?? (context ? this.frameTabs.get(context) : undefined);
    if (tabId === undefined) return;
    if (m.method === "browsingContext.contextDestroyed") { if (this.contexts.get(tabId) === context) this.contexts.delete(tabId); if (context) this.frameTabs.delete(context); return; }
    if (m.method === "browsingContext.downloadWillBegin") this.onEvent(tabId, "Page.downloadWillBegin", { guid: m.params.download ?? m.params.navigation, url: m.params.url, suggestedFilename: m.params.suggestedFilename });
    if (m.method === "browsingContext.downloadEnd" && (m.params.status === "complete" || m.params.status === "canceled")) this.onEvent(tabId, "Page.downloadProgress", { guid: m.params.download ?? m.params.navigation, state: m.params.status === "complete" ? "completed" : "canceled", filePath: "filepath" in m.params ? m.params.filepath : undefined });
    if (m.method === "log.entryAdded") this.onEvent(tabId, "Runtime.consoleAPICalled", { type: m.params.level, args: "args" in m.params ? m.params.args.map(v => ({ type: v.type, value: remoteValue(v) })) : [{ value: m.params.text }], timestamp: m.params.timestamp });
    if (m.method === "browsingContext.userPromptOpened") { if (context) this.dialogs.set(tabId, context); this.onEvent(tabId, "Page.javascriptDialogOpening", { type: m.params.type, message: m.params.message }); }
    if (m.method === "browsingContext.userPromptClosed") { this.dialogs.delete(tabId); this.onEvent(tabId, "Page.javascriptDialogClosed", { result: m.params.accepted }); }
    if (m.method === "network.beforeRequestSent") this.onEvent(tabId, "Network.requestWillBeSent", { requestId: m.params.request.request, request: { url: m.params.request.url, method: m.params.request.method, headers: Object.fromEntries((m.params.request.headers ?? []).map(h => [h.name, h.value.value])) }, timestamp: m.params.timestamp, type: "Other" });
    if (m.method === "network.responseCompleted") this.onEvent(tabId, "Network.responseReceived", { requestId: m.params.request.request, response: { url: m.params.response.url, status: m.params.response.status, mimeType: m.params.response.mimeType, headers: Object.fromEntries((m.params.response.headers ?? []).map(h => [h.name, h.value.value])) }, timestamp: m.params.timestamp, type: "Other" });
    if (m.method === "network.fetchError") this.onEvent(tabId, "Network.loadingFailed", { requestId: m.params.request.request, errorText: m.params.errorText });
  }
  normalize(r: Script.EvaluateResult, context: string, owned: boolean): NormalizedEvaluation {
    if (r.type === "exception") return { exceptionDetails: { text: r.exceptionDetails.text ?? "Firefox evaluation failed" } };
    const v = r.result;
    const handle = "handle" in v ? v.handle : undefined;
    const sharedId = "sharedId" in v ? v.sharedId : undefined;
    const id = handle ?? sharedId;
    if (owned && id) {
      this.objects.set(id, { context, ...(handle ? { handle } : {}), ...(sharedId ? { sharedId } : {}) });
      return { result: { type: "object", subtype: v.type === "node" ? "node" : undefined, objectId: id } };
    }
    return { result: { type: v.type, value: remoteValue(v) } };
  }
  async command(tabId: number, method: string, input: unknown = {}, timeoutMs = 10000): Promise<unknown> {
    const p = record(input);
    let context = this.contexts.get(tabId);
    if (!context) throw Object.assign(new Error("Debugger unattached: Firefox bridge required"), { code: "DEBUGGER_DETACHED", executionState: "not_started", uncertain: false });
    const root = context;
    const deadlineAt = Date.now() + timeoutMs;
    const run: BidiSend = (name, args) => beforeDeadline(() => this.send(name, args, Math.max(1, deadlineAt - Date.now() + 1000)), deadlineAt, { tabId, method: name, phase: "Firefox command" });
    if (method === "Page.handleJavaScriptDialog") return run("browsingContext.handleUserPrompt", { context: this.dialogs.get(tabId) ?? root, accept: p.accept === true, ...(p.promptText ? { userText: text(p.promptText, "promptText") } : {}) });
    if (typeof p.agentFrameId === "string" && p.agentFrameId !== "main") {
      context = await resolveFirefoxFrame(run, root, p.agentFrameId);
      this.frameTabs.set(context, tabId);
      await run("script.callFunction", { functionDeclaration: fileGuard, target: { context }, awaitPromise: false });
    } else if (typeof p.objectId === "string" && this.objects.get(p.objectId)?.context !== root) {
      const owned = this.objects.get(p.objectId);
      if (owned) { if (this.frameTabs.get(owned.context) !== tabId) throw new Error("Stale Firefox object"); await verifyFirefoxContext(run, root, owned.context); context = owned.context; }
    }
    const selectedContext = context;
    const evaluate = async (expression: string, owned = false) => this.normalize(await run("script.evaluate", { expression: typeof p.agentFrameId === "string" ? `globalThis.__agentBrowserFrameId=${JSON.stringify(p.agentFrameId)};\n${expression}` : expression, target: { context: selectedContext }, awaitPromise: true, resultOwnership: owned ? "root" : "none", serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 } }), selectedContext, owned);
    const value = async (expression: string): Promise<unknown> => (await evaluate(expression)).result?.value;
    if (method === "OpenCode.framePoint") return translateFirefoxPoint(run, root, context, { x: number(p.x, "x"), y: number(p.y, "y") }, remoteValue);
    const reference = (): Script.RemoteReference => { const r = this.objects.get(text(p.objectId, "objectId")); if (!r || r.context !== context) throw new Error("Stale Firefox object"); if (r.handle) return { handle: r.handle }; if (r.sharedId) return { sharedId: r.sharedId }; throw new Error("Stale Firefox object"); };
    if (/^(Page|Runtime|Log|Network|Performance|DOM|Accessibility)\.enable$/.test(method)) return {};
    if (method === "Page.setInterceptFileChooserDialog") return {};
    if (method === "Runtime.evaluate") {
      if (!p.contextId) return evaluate(text(p.expression, "expression"), p.returnByValue === false);
      const tree = await run("browsingContext.getTree", { root, maxDepth: 8 });
      const pending = [...tree.contexts]; let found = false, visited = 0;
      while (pending.length && visited++ < 100) { const frame = pending.shift(); if (!frame) break; if (frame.context === p.contextId) { found = true; break; } pending.push(...(frame.children ?? []).slice(0, 50)); }
      if (!found) throw new Error("Stale or unowned Firefox frame context");
      this.frameTabs.set(text(p.contextId, "contextId"), tabId);
      return this.normalize(await run("script.evaluate", { expression: text(p.expression, "expression"), target: { context: text(p.contextId, "contextId") }, awaitPromise: true, resultOwnership: p.returnByValue === false ? "root" : "none", serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 } }), text(p.contextId, "contextId"), p.returnByValue === false);
    }
    if (method === "Runtime.callFunctionOn") return this.normalize(await run("script.callFunction", { functionDeclaration: text(p.functionDeclaration, "functionDeclaration"), target: { context }, this: reference(), arguments: (Array.isArray(p.arguments) ? p.arguments : []).map(a => localValue(record(a).value)), awaitPromise: true }), context, false);
    if (method === "Runtime.releaseObject") { const r = this.objects.get(text(p.objectId, "objectId")); this.objects.delete(text(p.objectId, "objectId")); if (r?.handle) await run("script.disown", { target: { context }, handles: [r.handle] }); return {}; }
    if (method === "DOM.describeNode") {
      const r = await run("script.callFunction", { functionDeclaration: "function(){return {nodeName:this.nodeName,localName:this.localName,attributes:Array.from(this.attributes||[]).flatMap(a=>[a.name,a.value])}}", target: { context }, this: reference(), awaitPromise: false }); return { node: r.type === "success" ? remoteValue(r.result) : undefined };
    }
    if (method === "DOM.setFileInputFiles") { reference(); const r = this.objects.get(text(p.objectId, "objectId")); if (!r?.sharedId) throw new Error("Upload requires a live Firefox node"); return run("input.setFiles", { context, element: { sharedId: r.sharedId }, files: Array.isArray(p.files) ? p.files.map(file => text(file, "upload file")) : [] }); }
    if (method === "Page.navigate") return run("browsingContext.navigate", { context, url: text(p.url, "url"), wait: "interactive" });
    if (method === "Page.getFrameTree" || method === "Page.createIsolatedWorld") {
      const { frameTree, contexts } = await bridgedFrameTree({ send: run, root: context, maxDepth: number(p.maxDepth, "maxDepth", 8), maxFrames: number(p.maxFrames, "maxFrames", 50) });
      for (const child of contexts.values()) this.frameTabs.set(child, tabId);
      if (method === "Page.getFrameTree") return { frameTree };
      if (contexts.has(text(p.frameId, "frameId"))) return { executionContextId: contexts.get(text(p.frameId, "frameId")) };
      throw new Error("Stale or unowned Firefox frame context");
    }
    if (method === "Page.stopLoading") { await value("window.stop()"); return {}; }
    if (method === "Page.setDocumentContent") { await value(`document.open();document.write(${JSON.stringify(p.html)});document.close()`); return {}; }
    if (method === "Page.getLayoutMetrics") { const size = await value("({x:0,y:0,width:Math.max(innerWidth,document.documentElement.scrollWidth),height:Math.max(innerHeight,document.documentElement.scrollHeight)})"); return { contentSize: size, cssContentSize: size }; }
    if (method === "Page.captureScreenshot") {
      if (p.format === "webp") throw new Error("unsupported_capability: Firefox screenshots support PNG and JPEG");
      return run("browsingContext.captureScreenshot", { context, origin: p.captureBeyondViewport ? "document" : "viewport", format: { type: `image/${p.format ?? "png"}`, ...(p.quality !== undefined ? { quality: number(p.quality, "quality") / 100 } : {}) }, ...(p.clip ? { clip: { type: "box", x: number(record(p.clip).x, "clip.x"), y: number(record(p.clip).y, "clip.y"), width: number(record(p.clip).width, "clip.width"), height: number(record(p.clip).height, "clip.height") } } : {}) });
    }
    if (method === "Input.dispatchMouseEvent") {
      if (context !== root && typeof p.x === "number" && typeof p.y === "number") Object.assign(p, await translateFirefoxPoint(run, root, context, { x: p.x, y: p.y }, remoteValue));
      context = root;
      if (p.type === "mouseWheel") return run("input.performActions", { context, actions: [{ type: "wheel", id: "opencode-pointer", actions: [{ type: "scroll", x: Math.round(number(p.x, "x", 0)), y: Math.round(number(p.y, "y", 0)), deltaX: Math.round(number(p.deltaX, "deltaX", 0)), deltaY: Math.round(number(p.deltaY, "deltaY", 0)) }] }] });
      const buttons: Record<string, number> = { left: 0, middle: 1, right: 2 };
      const action: Input.PointerSourceAction = p.type === "mouseMoved" ? { type: "pointerMove", x: Math.round(number(p.x, "x")), y: Math.round(number(p.y, "y")), origin: "viewport", duration: 0 } : { type: p.type === "mousePressed" ? "pointerDown" : "pointerUp", button: typeof p.button === "string" ? buttons[p.button] ?? 0 : 0 };
      return run("input.performActions", { context, actions: [{ type: "pointer", id: "opencode-pointer", parameters: { pointerType: "mouse" }, actions: [action] }] });
    }
    if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") {
      context = root;
      const actions: Input.KeySourceAction[] = method === "Input.insertText" || p.type === "char" ? [...text(p.text ?? "", "text")].flatMap(c => [{ type: "keyDown", value: c }, { type: "keyUp", value: c }]) : [{ type: p.type === "keyUp" ? "keyUp" : "keyDown", value: keys[text(p.key, "key")] ?? text(p.key, "key") }];
      return run("input.performActions", { context, actions: [{ type: "key", id: "opencode-keyboard", actions }] });
    }
    if (method === "Page.traverseHistory") return run("browsingContext.traverseHistory", { context, delta: number(p.delta, "delta") });
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 0, url: await value("location.href") }] };
    if (method === "Emulation.setDeviceMetricsOverride") return run("browsingContext.setViewport", { context, viewport: { width: number(p.width, "width"), height: number(p.height, "height") }, devicePixelRatio: number(p.deviceScaleFactor, "deviceScaleFactor", 1) });
    if (method === "Emulation.clearDeviceMetricsOverride") {
      for (const script of this.environmentPreloads.get(tabId) ?? []) await run("script.removePreloadScript", { script });
      this.environmentPreloads.delete(tabId);
      return run("browsingContext.setViewport", { context, viewport: null, devicePixelRatio: null });
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      const result = await run("script.addPreloadScript", { functionDeclaration: `()=>{${p.source}\n}`, contexts: [context] });
      this.environmentPreloads.set(tabId, [...(this.environmentPreloads.get(tabId) ?? []), result.script]);
      return { identifier: result.script };
    }
    if (method === "Performance.getMetrics") return { metrics: [] };
    throw new Error(`unsupported_capability: ${method} is unavailable on Firefox`);
  }
  async detach(tabId: number) {
    const context = this.contexts.get(tabId);
    const deadlineAt = Date.now() + 1250;
    const cleanup = async <K extends keyof Commands>(method: K, params: BidiParams<K>) => { await beforeDeadline(() => this.send(method, params, 1500), deadlineAt, { tabId, method, phase: "Firefox detach" }).catch(error => { if (record(error).code === "TIMEOUT") throw error; }); };
    if (context) {
      await cleanup("input.releaseActions", { context });
      await cleanup("script.evaluate", { target: { context }, awaitPromise: false, expression: "document.removeEventListener('click',globalThis.__opencodeFileGuard,true);delete globalThis.__opencodeFileGuard" });
    }
    const preload = this.preloads.get(tabId);
    if (preload) await cleanup("script.removePreloadScript", { script: preload });
    this.preloads.delete(tabId);
    for (const script of this.environmentPreloads.get(tabId) ?? []) await cleanup("script.removePreloadScript", { script });
    this.environmentPreloads.delete(tabId);
    this.contexts.delete(tabId);
    this.dialogs.delete(tabId);
    for (const [child, owner] of this.frameTabs) if (owner === tabId) { this.frameTabs.delete(child); for (const [id, object] of this.objects) if (object.context === child) this.objects.delete(id); }
    for (const [id, r] of this.objects) if (r.context === context) this.objects.delete(id);
    if (!this.contexts.size) await this.close();
    return {};
  }
  async close() {
    if (this.sessionId && this.socket?.readyState === 1) await this.send("session.end", {}, 1000).catch(() => {});
    this.sessionId = null;
    this.downloadCapabilities = { started: false, completed: false };
    this.socket?.close(); this.ready = null;
    this.contexts.clear(); this.frameTabs.clear(); this.dialogs.clear(); this.objects.clear(); this.preloads.clear(); this.environmentPreloads.clear();
  }
}
export function createFirefoxHost({ getProfile, onEvent }: { getProfile(): Pick<ProfileRegistration, "profileId" | "browserName"> | null; onEvent: EventSink }) {
  let backend: FirefoxBackend | undefined, endpoint: string | undefined;
  const handle = async (method: string, input: unknown) => {
    if (!method.startsWith("firefox.")) return undefined;
    const params = record(input);
    const profile = getProfile();
    if (!profile || !/Firefox|LibreWolf/i.test(profile.browserName ?? "")) throw new Error("Firefox transport requires a registered Firefox profile");
    const file = firefoxConfigPath(profile.profileId);
    if (!fs.existsSync(file)) throw new Error(`Firefox setup required: run opencode-chromium firefox configure --profile ${profile.profileId} --port PORT; launch that profile with --remote-debugging-port PORT`);
    const configured = validateEndpoint(record((JSON.parse(fs.readFileSync(file, "utf8")) as unknown)).endpoint);
    if (!backend || endpoint !== configured) { await backend?.close(); endpoint = configured; backend = new FirefoxBackend({ endpoint, onEvent }); }
    if (method === "firefox.attach") return backend.attach(number(params.tabId, "tabId"), text(params.marker, "marker"), number(params.deadlineAt, "deadlineAt", Date.now() + 10000));
    if (method === "firefox.detach") return backend.detach(number(params.tabId, "tabId"));
    if (method === "firefox.command") return backend.command(number(params.tabId, "tabId"), text(params.method, "method"), params.commandParams, Math.max(1, Math.min(number(params.timeoutMs, "timeoutMs", 10000), 120000)));
    if (method === "firefox.downloadCapabilities") { await backend.connect(); return { ...backend.downloadCapabilities }; }
    throw new Error("Unsupported Firefox host method");
  };
  handle.close = () => backend?.close();
  return handle;
}
