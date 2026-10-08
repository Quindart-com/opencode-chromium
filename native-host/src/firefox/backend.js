import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export function firefoxConfigPath(profileId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileId ?? "")) throw new Error("Invalid Firefox profile ID");
  const base = process.env.OPENCODE_BROWSER_RUNTIME_DIR ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCode", "browser") : path.join(os.homedir(), ".config", "opencode", "browser"));
  return path.join(base, "firefox", `${profileId}.json`);
}
export function validateEndpoint(value) {
  const u = new URL(value);
  if (u.protocol !== "ws:" || u.hostname !== "127.0.0.1" || !u.port || u.username || u.password || u.pathname !== "/session" || u.search || u.hash) throw new Error("Firefox endpoint must be ws://127.0.0.1:PORT/session");
  return u.href;
}
export function remoteValue(v) {
  if (!v || v.type === "undefined") return undefined;
  if (v.type === "null") return null;
  if (v.type === "array") return v.value.map(remoteValue);
  if (v.type === "object") return Object.fromEntries(v.value.map(([k, x]) => [typeof k === "string" ? k : remoteValue(k), remoteValue(x)]));
  return v.value;
}
const keys = { Enter: "\uE007", Tab: "\uE004", Escape: "\uE00C", Backspace: "\uE003", Delete: "\uE017", ArrowLeft: "\uE012", ArrowRight: "\uE014", ArrowUp: "\uE013", ArrowDown: "\uE015", Home: "\uE011", End: "\uE010", Control: "\uE009", Shift: "\uE008", Alt: "\uE00A", Meta: "\uE03D" };

const fileGuard = "function(){if(globalThis.__opencodeFileGuard)return;globalThis.__opencodeFileGuard=e=>{if(e.composedPath().some(n=>n instanceof HTMLInputElement&&n.type==='file'))e.preventDefault()};document.addEventListener('click',globalThis.__opencodeFileGuard,true)}";
// Internal page-command compatibility adapter. Firefox never receives CDP.
export class FirefoxBackend {
  constructor({ endpoint, WebSocketImpl = WebSocket, onEvent = () => {} } = {}) {
    Object.assign(this, { endpoint, WebSocketImpl, onEvent });
    this.pending = new Map(); this.contexts = new Map(); this.objects = new Map(); this.preloads = new Map(); this.environmentPreloads = new Map(); this.nextId = 1;
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const s = this.socket = new this.WebSocketImpl(validateEndpoint(this.endpoint));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { s.close(); reject(new Error("Firefox remote connection timed out")); }, 5000);
        s.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        s.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Firefox remote connection unavailable")); }, { once: true });
      });
      s.addEventListener("message", event => {
        if (this.socket !== s) return;
        let m; try { m = JSON.parse(String(event.data)); } catch { return; }
        const p = this.pending.get(m.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.id); if (m.type === "error") p.reject(new Error(`Firefox ${m.error}: ${m.message}`)); else p.resolve(m.result ?? {}); }
        else if (m.type === "event") this.event(m);
      });
      s.addEventListener("close", () => {
        if (this.socket !== s) return;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Firefox connection closed")); }
        this.pending.clear(); this.contexts.clear(); this.objects.clear(); this.preloads.clear(); this.environmentPreloads.clear(); this.sessionId = null; this.ready = null;
      });
      const session = await this.send("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: "ignore" } } } });
      this.sessionId = session.sessionId;
      const version = Number.parseInt(session.capabilities?.browserVersion ?? "0", 10);
      if (version < 140) throw new Error("Firefox 140 or later is required; update the selected browser before configuring automation");
      this.browserVersion = session.capabilities.browserVersion;
      await this.send("session.subscribe", { events: ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError", "browsingContext.userPromptOpened", "browsingContext.userPromptClosed", "browsingContext.contextDestroyed"] });
    })();
    try { await this.ready; } catch (e) { await this.close(); this.ready = null; throw e; }
  }
  send(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Firefox command timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async attach(tabId, marker) {
    if (!Number.isInteger(tabId) || !/^[a-f0-9]{32}$/.test(marker ?? "")) throw new Error("Invalid Firefox tab bridge");
    await this.connect();
    const { contexts } = await this.send("browsingContext.getTree", {});
    const matches = [];
    for (const c of contexts) {
      try {
        const r = await this.send("script.evaluate", { expression: "document.documentElement?.getAttribute('data-opencode-bidi-bridge')", target: { context: c.context }, awaitPromise: false });
        if (remoteValue(r.result) === marker) matches.push(c.context);
      } catch { /* Ignore unrelated privileged tabs. */ }
    }
    if (matches.length !== 1) throw new Error("Firefox tab/profile bridge could not be verified; check the configured profile and port");
    const context = matches[0];
    this.contexts.set(tabId, context);
    try {
      const result = await this.send("script.addPreloadScript", { functionDeclaration: fileGuard, contexts: [context] });
      this.preloads.set(tabId, result.script);
      await this.send("script.callFunction", { functionDeclaration: fileGuard, target: { context }, awaitPromise: false });
    } catch (error) { this.contexts.delete(tabId); throw error; }
    return {};
  }
  event(m) {
    const p = m.params ?? {}; const context = p.context ?? p.source?.context;
    const tabId = [...this.contexts].find(([, c]) => c === context)?.[0];
    if (tabId === undefined) return;
    if (m.method === "browsingContext.contextDestroyed") { this.contexts.delete(tabId); return; }
    if (m.method === "log.entryAdded") this.onEvent(tabId, "Runtime.consoleAPICalled", { type: p.level, args: p.args?.map(v => ({ type: v.type, value: remoteValue(v) })) ?? [{ value: p.text }], timestamp: p.timestamp });
    if (m.method === "browsingContext.userPromptOpened") this.onEvent(tabId, "Page.javascriptDialogOpening", { type: p.type, message: p.message, url: p.url });
    if (m.method === "browsingContext.userPromptClosed") this.onEvent(tabId, "Page.javascriptDialogClosed", { result: p.accepted });
    if (m.method === "network.beforeRequestSent") this.onEvent(tabId, "Network.requestWillBeSent", { requestId: p.request.request, request: { url: p.request.url, method: p.request.method, headers: Object.fromEntries((p.request.headers ?? []).map(h => [h.name, h.value.value])) }, timestamp: p.timestamp, type: "Other" });
    if (m.method === "network.responseCompleted") this.onEvent(tabId, "Network.responseReceived", { requestId: p.request.request, response: { url: p.response.url, status: p.response.status, mimeType: p.response.mimeType, headers: Object.fromEntries((p.response.headers ?? []).map(h => [h.name, h.value.value])) }, timestamp: p.timestamp, type: "Other" });
    if (m.method === "network.fetchError") this.onEvent(tabId, "Network.loadingFailed", { requestId: p.request.request, errorText: p.errorText });
  }
  normalize(r, context, owned) {
    if (r.type === "exception") return { exceptionDetails: { text: r.exceptionDetails?.text ?? "Firefox evaluation failed" } };
    const v = r.result;
    if (owned && (v.handle || v.sharedId)) {
      const id = v.handle ?? v.sharedId; this.objects.set(id, { context, ...(v.handle ? { handle: v.handle } : {}), ...(v.sharedId ? { sharedId: v.sharedId } : {}) });
      return { result: { type: "object", subtype: v.type === "node" ? "node" : undefined, objectId: id } };
    }
    return { result: { type: v.type, value: remoteValue(v) } };
  }
  async command(tabId, method, p = {}, timeoutMs = 10000) {
    const context = this.contexts.get(tabId);
    if (!context) throw new Error("Debugger unattached: Firefox bridge required");
    const run = (name, args) => this.send(name, args, timeoutMs);
    const evaluate = async (expression, owned = false) => this.normalize(await run("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: owned ? "root" : "none", serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 } }), context, owned);
    const value = async expression => (await evaluate(expression)).result?.value;
    const reference = () => { const r = this.objects.get(p.objectId); if (!r || r.context !== context) throw new Error("Stale Firefox object"); return r.handle ? { handle: r.handle } : { sharedId: r.sharedId }; };
    if (/^(Page|Runtime|Log|Network|Performance|DOM|Accessibility)\.enable$/.test(method)) return {};
    if (method === "Page.setInterceptFileChooserDialog") return {};
    if (method === "Runtime.evaluate") return evaluate(p.expression, p.returnByValue === false);
    if (method === "Runtime.callFunctionOn") return this.normalize(await run("script.callFunction", { functionDeclaration: p.functionDeclaration, target: { context }, this: reference(), arguments: (p.arguments ?? []).map(a => ({ type: typeof a.value, value: a.value })), awaitPromise: true }), context, false);
    if (method === "Runtime.releaseObject") { const r = this.objects.get(p.objectId); this.objects.delete(p.objectId); if (r?.handle) await run("script.disown", { target: { context }, handles: [r.handle] }); return {}; }
    if (method === "DOM.describeNode") {
      const r = await run("script.callFunction", { functionDeclaration: "function(){return {nodeName:this.nodeName,localName:this.localName,attributes:Array.from(this.attributes||[]).flatMap(a=>[a.name,a.value])}}", target: { context }, this: reference(), awaitPromise: false }); return { node: remoteValue(r.result) };
    }
    if (method === "DOM.setFileInputFiles") { reference(); const r = this.objects.get(p.objectId); if (!r.sharedId) throw new Error("Upload requires a live Firefox node"); return run("input.setFiles", { context, element: { sharedId: r.sharedId }, files: p.files }); }
    if (method === "Page.navigate") return run("browsingContext.navigate", { context, url: p.url, wait: "interactive" });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: context, url: await value("location.href") } } };
    if (method === "Page.setDocumentContent") { await value(`document.open();document.write(${JSON.stringify(p.html)});document.close()`); return {}; }
    if (method === "Page.getLayoutMetrics") { const size = await value("({x:0,y:0,width:Math.max(innerWidth,document.documentElement.scrollWidth),height:Math.max(innerHeight,document.documentElement.scrollHeight)})"); return { contentSize: size, cssContentSize: size }; }
    if (method === "Page.captureScreenshot") {
      if (p.format === "webp") throw new Error("unsupported_capability: Firefox screenshots support PNG and JPEG");
      return run("browsingContext.captureScreenshot", { context, origin: p.captureBeyondViewport ? "document" : "viewport", format: { type: `image/${p.format ?? "png"}`, ...(p.quality !== undefined ? { quality: p.quality / 100 } : {}) }, ...(p.clip ? { clip: { type: "box", x: p.clip.x, y: p.clip.y, width: p.clip.width, height: p.clip.height } } : {}) });
    }
    if (method === "Page.handleJavaScriptDialog") return run("browsingContext.handleUserPrompt", { context, accept: p.accept, ...(p.promptText ? { userText: p.promptText } : {}) });
    if (method === "Input.dispatchMouseEvent") {
      const actions = p.type === "mouseWheel" ? [{ type: "scroll", x: Math.round(p.x ?? 0), y: Math.round(p.y ?? 0), deltaX: Math.round(p.deltaX ?? 0), deltaY: Math.round(p.deltaY ?? 0) }] : p.type === "mouseMoved" ? [{ type: "pointerMove", x: Math.round(p.x), y: Math.round(p.y), origin: "viewport", duration: 0 }] : [{ type: p.type === "mousePressed" ? "pointerDown" : "pointerUp", button: ({ left: 0, middle: 1, right: 2 })[p.button] ?? 0 }];
      return run("input.performActions", { context, actions: [{ type: p.type === "mouseWheel" ? "wheel" : "pointer", id: "opencode-pointer", ...(p.type === "mouseWheel" ? {} : { parameters: { pointerType: "mouse" } }), actions }] });
    }
    if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") {
      const actions = method === "Input.insertText" || p.type === "char" ? [...(p.text ?? "")].flatMap(c => [{ type: "keyDown", value: c }, { type: "keyUp", value: c }]) : [{ type: p.type === "keyUp" ? "keyUp" : "keyDown", value: keys[p.key] ?? p.key }];
      return run("input.performActions", { context, actions: [{ type: "key", id: "opencode-keyboard", actions }] });
    }
    if (method === "Page.traverseHistory") return run("browsingContext.traverseHistory", { context, delta: p.delta });
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 0, url: await value("location.href") }] };
    if (method === "Emulation.setDeviceMetricsOverride") return run("browsingContext.setViewport", { context, viewport: { width: p.width, height: p.height }, devicePixelRatio: p.deviceScaleFactor });
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
  async detach(tabId) {
    const context = this.contexts.get(tabId);
    if (context) {
      await this.send("input.releaseActions", { context }).catch(() => {});
      await this.send("script.evaluate", { target: { context }, awaitPromise: false, expression: "document.removeEventListener('click',globalThis.__opencodeFileGuard,true);delete globalThis.__opencodeFileGuard" }).catch(() => {});
    }
    const preload = this.preloads.get(tabId);
    if (preload) await this.send("script.removePreloadScript", { script: preload }).catch(() => {});
    this.preloads.delete(tabId);
    for (const script of this.environmentPreloads.get(tabId) ?? []) await this.send("script.removePreloadScript", { script }).catch(() => {});
    this.environmentPreloads.delete(tabId);
    this.contexts.delete(tabId);
    for (const [id, r] of this.objects) if (r.context === context) this.objects.delete(id);
    if (!this.contexts.size) await this.close();
    return {};
  }
  async close() {
    if (this.sessionId && this.socket?.readyState === 1) await this.send("session.end", {}, 1000).catch(() => {});
    this.sessionId = null;
    this.socket?.close(); this.ready = null;
    this.contexts.clear(); this.objects.clear(); this.preloads.clear(); this.environmentPreloads.clear();
  }
}
export function createFirefoxHost({ getProfile, onEvent }) {
  let backend, endpoint;
  const handle = async (method, params) => {
    if (!method.startsWith("firefox.")) return undefined;
    const profile = getProfile();
    if (!/Firefox|LibreWolf/i.test(profile?.browserName ?? "")) throw new Error("Firefox transport requires a registered Firefox profile");
    const file = firefoxConfigPath(profile.profileId);
    if (!fs.existsSync(file)) throw new Error(`Firefox setup required: run opencode-chromium firefox configure --profile ${profile.profileId} --port PORT; launch that profile with --remote-debugging-port PORT`);
    const configured = validateEndpoint(JSON.parse(fs.readFileSync(file, "utf8")).endpoint);
    if (!backend || endpoint !== configured) { await backend?.close(); endpoint = configured; backend = new FirefoxBackend({ endpoint, onEvent }); }
    if (method === "firefox.attach") return backend.attach(params.tabId, params.marker);
    if (method === "firefox.detach") return backend.detach(params.tabId);
    if (method === "firefox.command") return backend.command(params.tabId, params.method, params.commandParams, Math.max(1, Math.min(params.timeoutMs ?? 10000, 120000)));
    throw new Error("Unsupported Firefox host method");
  };
  handle.close = () => backend?.close();
  return handle;
}
