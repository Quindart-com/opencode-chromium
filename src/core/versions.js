import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "opencode-browser-plugin";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PLUGIN_VERSION = packageVersion();
export const PROTOCOL_VERSION = "1";
export const SCHEMA_VERSION = "1";
export const CAPABILITY_VERSION = "1";

export function contractMetadata(overrides = {}) {
  return {
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    capabilityVersion: CAPABILITY_VERSION,
    ...(overrides.extensionVersion != null ? { extensionVersion: overrides.extensionVersion } : {}),
    ...(overrides.nativeHostVersion != null ? { nativeHostVersion: overrides.nativeHostVersion } : {}),
    ...overrides,
  };
}

export function versionInfo(overrides = {}) {
  return contractMetadata(overrides);
}

export function isCompatibleVersion(actual, expected = PROTOCOL_VERSION) {
  return String(actual ?? "") === String(expected);
}

export function assertCompatibleVersion(actual, expected = PROTOCOL_VERSION, component = "protocol") {
  if (isCompatibleVersion(actual, expected)) return true;
  const error = new Error(`${component} version ${actual ?? "missing"} is not compatible with ${expected}`);
  error.code = "VERSION_MISMATCH";
  error.retryable = false;
  error.uncertain = false;
  error.expected = expected;
  error.actual = actual ?? null;
  throw error;
}
