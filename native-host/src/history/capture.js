import { CAPTURED_METHODS, extractHostname, opaqueId } from "./events.js";

function sessionIdFromParams(params) {
  if (!params || typeof params !== "object") return null;
  const value = params.session_id ?? params.sessionId ?? params.sessionID;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function tabIdFromParams(params) {
  if (!params || typeof params !== "object") return null;
  return Number.isInteger(params.tabId) && params.tabId > 0 ? params.tabId : null;
}

function collectTabUrlPairs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectTabUrlPairs(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Number.isInteger(value.id) && typeof value.url === "string") out.push({ id: value.id, url: value.url });
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectTabUrlPairs(nested, out);
  }
}

export class HistoryCapture {
  constructor({ store }) {
    this.store = store;
    this.tabHostnames = new Map();
  }

  startAgentRequest(message) {
    const store = this.store;
    if (!store?.state?.enabled || store.state.paused) return null;
    const method = message?.method;
    const capability = CAPTURED_METHODS.get(method);
    if (!capability || message.id === undefined) return null;
    const params = message.params ?? {};
    const sessionId = sessionIdFromParams(params);
    if (!sessionId) return null;
    const tabId = tabIdFromParams(params);
    const application = tabId !== null ? this.applicationFor(tabId) : null;
    const actionId = opaqueId();
    store.record({
      kind: "action_started",
      sessionId,
      actionId,
      capability,
      application,
      payload: { kind: "action_started" },
    });
    return { actionId, method, sessionId, tabId };
  }

  completeAgentRequest(capture, outcome, errorCode = null) {
    if (!capture || !this.store) return;
    const application = capture.tabId !== null ? this.applicationFor(capture.tabId) : null;
    this.store.record({
      kind: "action_completed",
      sessionId: capture.sessionId,
      actionId: capture.actionId,
      capability: CAPTURED_METHODS.get(capture.method) ?? null,
      application,
      payload: {
        kind: "action_completed",
        effect: outcome,
        route: "relay",
        delivery: "foreground",
        ...(outcome === "failed" ? { error_code: errorCode ?? null } : {}),
      },
    });
  }

  noteResponse(result) {
    if (!this.store?.state?.enabled) return;
    const pairs = [];
    collectTabUrlPairs(result, pairs);
    for (const { id, url } of pairs) {
      const hostname = extractHostname(url);
      if (hostname) this.tabHostnames.set(id, hostname);
    }
  }

  applicationFor(tabId) {
    const hostname = Number.isInteger(tabId) ? this.tabHostnames.get(tabId) : null;
    return hostname ? { hostname } : null;
  }
}