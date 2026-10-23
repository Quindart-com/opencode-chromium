import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "../shared/values.ts";
import { BrowserRuntimeError } from "./errors.ts";

export const PLUGIN_NAME = "opencode-browser-plugin";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageVersion() {
  try {
    const version = record((JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as unknown)).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PLUGIN_VERSION = packageVersion();
export const PROTOCOL_VERSION = "1";

export function contractMetadata(overrides: Record<string, unknown> & { extensionVersion?: string | null; nativeHostVersion?: string | null } = {}) {
  return {
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    ...(overrides.extensionVersion != null ? { extensionVersion: overrides.extensionVersion } : {}),
    ...(overrides.nativeHostVersion != null ? { nativeHostVersion: overrides.nativeHostVersion } : {}),
    ...overrides,
  };
}

// Normal tool output only needs the release identity. Wire protocol negotiation
// remains in the native-host handshake, outside the agent's repeated context.
export function responseMetadata() { return { pluginVersion: PLUGIN_VERSION }; }

export function versionInfo(overrides: Parameters<typeof contractMetadata>[0] = {}) {
  return contractMetadata(overrides);
}

export function isCompatibleVersion(actual: unknown, expected = PROTOCOL_VERSION) {
  return String(actual ?? "") === String(expected);
}

export function assertCompatibleVersion(actual: unknown, expected = PROTOCOL_VERSION, component = "protocol") {
  if (isCompatibleVersion(actual, expected)) return true;
  const error = Object.assign(new BrowserRuntimeError(`${component} version ${actual ?? "missing"} is not compatible with ${expected}`, { code: "VERSION_MISMATCH" }), { expected, actual: actual ?? null });
  throw error;
}
