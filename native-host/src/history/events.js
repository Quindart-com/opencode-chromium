import { createHash, randomBytes } from "node:crypto";
import { EVENT_SCHEMA } from "./config.js";

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

export const HEALTH_CATEGORIES = new Set([
  "ready",
  "disabled",
  "paused",
  "key_unavailable",
  "storage_unavailable",
  "storage_corrupt",
  "quota_reached",
  "events_dropped",
  "writer_stopped",
]);

export function eventType(kind) {
  return `opencode-browser-plugin.history.${kind}.v0`;
}

export function opaqueId() {
  return randomBytes(16).toString("hex");
}

export function storeIdentifier(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

export function extractHostname(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) return null;
  if (/^(chrome|edge|brave|vivaldi|opera|chrome-extension|about|data|blob|file):/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname?.toLowerCase();
    if (!hostname) return null;
    return hostname.length <= 255 ? hostname : null;
  } catch {
    return null;
  }
}

export function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  const hostname = value.toLowerCase();
  if (hostname.length === 0 || hostname.length > 255) return null;
  if (/[\s\\/]/.test(hostname)) return null;
  return hostname;
}

let sourceByRoot = new Map();

export function sourceFor(root) {
  if (!sourceByRoot.has(root)) sourceByRoot.set(root, `urn:opencode-browser-plugin:history:${storeIdentifier(root)}`);
  return sourceByRoot.get(root);
}

export function buildEvent({ root, sequence, kind, sessionId = null, actionId = null, capability = null, callerCategory = "agent_runtime", application = null, payload = null }) {
  const subject = kind === "session_started" || kind === "session_ended"
    ? `session/${sessionId ?? "?"}`
    : kind === "action_started" || kind === "action_completed"
      ? `action/${actionId ?? "?"}`
      : `history/${opaqueId()}`;
  const data = {
    sequence,
    platform: process.platform,
    process_model: "in_native_host",
    caller_category: callerCategory,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(actionId ? { action_id: actionId } : {}),
    ...(capability ? { capability } : {}),
    ...(application ? { application } : {}),
    payload: payload ?? { kind },
  };
  return {
    specversion: "1.0",
    id: opaqueId(),
    source: sourceFor(root),
    type: eventType(kind),
    subject,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    dataschema: EVENT_SCHEMA,
    data,
  };
}

export function actionPayload({ status }) {
  if (status === "completed") {
    return { kind: "action_completed", effect: "confirmed", route: "relay", delivery: "foreground" };
  }
  if (status === "failed") {
    return { kind: "action_completed", effect: "failed", route: "relay", delivery: "foreground" };
  }
  return { kind: "action_started" };
}