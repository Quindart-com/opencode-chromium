export const PLUGIN_NAME = "opencode-browser-plugin";
export const PLUGIN_VERSION = "1.2.0";
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
    extensionVersion: overrides.extensionVersion ?? null,
    nativeHostVersion: overrides.nativeHostVersion ?? null,
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
