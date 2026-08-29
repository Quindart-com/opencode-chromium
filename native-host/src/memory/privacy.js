import { MAX_LABEL_CHARS } from "./config.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_NUMERIC = /\b\w*\d[\d_-]{7,}\w*\b/g;
const URL_QUERY = /\?[^\\s"'<>]+/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{24,}\b/g;
const FILE_PATH = /(?:[A-Za-z]:[\\/][^\s"']{2,}|\/(?:Users|home|Library|var|etc|usr)\/[^\s"']{2,})/g;
const BEARER = /\b(?:bearer|token|password|secret|api[_-]?key)\b\s*[:=]\s*\S+/gi;

function collapseSpaces(value) {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeLabel(value) {
  if (typeof value !== "string") return null;
  const stripped = value
    .replace(BEARER, "[credential]")
    .replace(FILE_PATH, "[path]")
    .replace(JWT_LIKE, "[token]")
    .replace(EMAIL, "[email]")
    .replace(UUID, "[id]")
    .replace(URL_QUERY, "[query]")
    .replace(LONG_NUMERIC, "[id]")
    .replace(TOKEN_LIKE, "[token]");
  const cleaned = collapseSpaces(stripped);
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_LABEL_CHARS ? cleaned.slice(0, MAX_LABEL_CHARS).trimEnd() : cleaned;
}

export function safeSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 300) return null;
  if (/@/.test(selector)) return null;
  if (/\bhttps?:\/\//i.test(selector)) return null;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(selector)) return null;
  if (/\beyJ[A-Za-z0-9_-]{8,}\b/.test(selector)) return null;
  if (/\b[A-Za-z0-9_-]{40,}\b/.test(selector)) return null;
  if (/\d[\d_-]{11,}/.test(selector)) return null;
  const cleaned = collapseSpaces(selector);
  if (cleaned.length === 0 || cleaned.length > 300) return null;
  return cleaned;
}

export function sanitizeTarget(target = {}) {
  const query = sanitizeLabel(target.query ?? target.label ?? null);
  const role = typeof target.role === "string" && target.role.length <= 64 ? target.role : null;
  const rawSelector = typeof target.selector === "string" ? target.selector : null;
  return {
    label: query,
    role,
    selector: query === null ? safeSelector(rawSelector) : null,
  };
}

export function chainSearchText(hostname, steps = []) {
  const parts = [];
  if (hostname) parts.push(String(hostname));
  for (const step of steps) {
    if (!step || typeof step.action !== "string") continue;
    const fragments = [step.action];
    if (step.target_role) fragments.push(step.target_role);
    if (step.target_label) fragments.push(step.target_label);
    parts.push(fragments.filter(Boolean).join(" "));
  }
  return parts.join(" ").slice(0, 512);
}
