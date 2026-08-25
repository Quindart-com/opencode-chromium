import { MAX_LABEL_CHARS } from "./config.js";
import { buildSignature, fingerprintFor, normalizeHostname } from "./signature.js";

export const CAPTURED_METHODS = new Map([
  ["createTab", "browser.tab.create"],
  ["claimUserTab", "browser.tab.claim"],
  ["closeTab", "browser.tab.close"],
  ["releaseTab", "browser.tab.release"],
  ["reloadTab", "browser.tab.reload"],
  ["activateTab", "browser.tab.activate"],
  ["executeCdp", "browser.cdp.execute"],
  ["inputGesture", "browser.input.gesture"],
  ["moveMouse", "browser.pointer.move"],
  ["finalizeTabs", "browser.session.finalize"],
  ["turnEnded", "browser.session.turn_end"],
  ["nameSession", "browser.session.name"],
]);

function sessionIdFromParams(params) {
  if (!params || typeof params !== "object") return null;
  const value = params.session_id ?? params.sessionId ?? params.sessionID;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function tabIdFromParams(params) {
  if (!params || typeof params !== "object") return null;
  return Number.isInteger(params.tabId) && params.tabId > 0 ? params.tabId : null;
}

function boundedLabel(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_LABEL_CHARS ? cleaned.slice(0, MAX_LABEL_CHARS).trimEnd() : cleaned;
}

function stringValue(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export class MemoryCapture {
  constructor({ store, chainFallbackWindowMs = 120000 } = {}) {
    this.store = store;
    this.tabHostnames = new Map();
    this.tabTitles = new Map();
    this.openByRequestId = new Map();
    this.chainFallbackWindowMs = chainFallbackWindowMs;
  }

  startAgentRequest(message) {
    if (!this.store?.open || this.store.meta.enabled !== "true" || this.store.meta.paused === "true") return null;
    const method = message?.method;
    const capability = CAPTURED_METHODS.get(method);
    if (!capability || message.id === undefined) return null;
    const params = message.params ?? {};
    const sessionId = sessionIdFromParams(params);
    const tabId = tabIdFromParams(params);
    const label = boundedLabel(params.memory_label ?? params.label ?? null);
    const chainId = stringValue(params.memory_chain_id || params.chain_id);
    const stepIndex = Number.isInteger(params.memory_step_index) ? params.memory_step_index : null;
    const hostname = this.applicationFor(tabId);
    const fingerprint = chainIdStepFingerprint(chainId, stepIndex);

    if (chainId) {
      const sourceSession = sessionId ?? null;
      this.store.ensureChain({ chainId, intent: stringValue(params.memory_intent) ?? null, sessionId });
    }

    const record = { method, capability, sessionId, tabId, hostname, label, chainId, stepIndex, requestId: String(message.id), startedAt: Date.now() };
    this.openByRequestId.set(record.requestId, record);
    return record;
  }

  completeAgentRequest(capture, success, errorCode = null) {
    if (!capture || !this.store?.open) return;
    this.openByRequestId.delete(capture.requestId);
    this.store.record({
      success,
      capability: capture.capability,
      hostname: this.applicationFor(capture.tabId),
      label: capture.label,
      errorCode: success ? null : errorCode ?? "unknown",
      stepIndex: capture.stepIndex,
      chainId: capture.chainId,
      sessionId: capture.sessionId,
    });
  }

  noteResponse(result) {
    if (!this.store?.open) return;
    const pairs = [];
    collectTabInfoPairs(result, pairs, this.tabHostnames.size + pairs.length);
    for (const { id, url, title } of pairs) {
      const hostname = extractHostname(url);
      if (hostname) this.tabHostnames.set(id, hostname);
      if (title) this.tabTitles.set(id, boundedLabel(title));
    }
  }

  noteError(messageId, errorCode = null) {
    const capture = this.openByRequestId.get(String(messageId));
    if (!capture) return;
    this.completeAgentRequest(capture, false, errorCode ?? "unknown");
  }

  applicationFor(tabId) {
    return Number.isInteger(tabId) ? this.tabHostnames.get(tabId) ?? null : null;
  }

  flush() {
    // capture is synchronous with the store writer; nothing buffered
  }

  close() {
    this.openByRequestId.clear();
  }
}

function chainIdStepFingerprint(chainId, stepIndex) {
  return `${chainId ?? "?"}:${stepIndex ?? "?"}`;
}

function collectTabInfoPairs(value, out, depth = 0) {
  if (depth > 32) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTabInfoPairs(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Number.isInteger(value.id) && typeof value.url === "string") {
    out.push({ id: value.id, url: value.url, title: typeof value.title === "string" ? value.title : null });
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectTabInfoPairs(nested, out, depth + 1);
  }
}

export function extractHostname(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) return null;
  if (/^(chrome|edge|brave|vivaldi|opera|chrome-extension|about|data|blob|file):/i.test(url)) return null;
  try {
    const hostname = new URL(url).hostname?.toLowerCase();
    if (!hostname) return null;
    return normalizeHostname(hostname);
  } catch {
    return null;
  }
}