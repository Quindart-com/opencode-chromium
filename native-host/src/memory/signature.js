import { createHash } from "node:crypto";
import { MAX_LABEL_CHARS } from "./config.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_LABEL_CHARS ? cleaned.slice(0, MAX_LABEL_CHARS).trimEnd() : cleaned;
}

export function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  const hostname = value.trim().toLowerCase();
  if (hostname.length === 0 || hostname.length > 255) return null;
  if (/[\s\\/]/.test(hostname)) return null;
  return hostname;
}

export function verbForCapability(capability) {
  if (typeof capability !== "string" || capability.length === 0) return null;
  return capability.split(".").slice(1).join(".") || capability;
}

export function buildSignature({ capability, hostname = null, verb = null, label = null }) {
  const normalizedCapability = typeof capability === "string" ? capability : null;
  const normalizedVerb = verb ?? verbForCapability(normalizedCapability);
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedLabel = normalizeLabel(label);
  const parts = [normalizedCapability ?? "unknown", normalizedVerb ?? "unknown", normalizedHostname ?? "?", normalizedLabel ?? "?"];
  return {
    signature: parts.join(" | "),
    capability: normalizedCapability,
    verb: normalizedVerb,
    hostname: normalizedHostname,
    label: normalizedLabel,
  };
}

export function fingerprintFor(parts) {
  return createHash("sha256").update(parts.signature, "utf8").digest("hex");
}