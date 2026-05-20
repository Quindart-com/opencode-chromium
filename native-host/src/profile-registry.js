import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGISTRY_DIR_ENV = "OPENCODE_BROWSER_PROFILE_REGISTRY_DIR";
const REGISTRY_VERSION = 1;

export function profileRegistryDir() {
  if (process.env[REGISTRY_DIR_ENV]) return path.resolve(process.env[REGISTRY_DIR_ENV]);
  return path.join(os.tmpdir(), "opencode-browser-profiles");
}

function safeFileName(value) {
  const name = String(value ?? "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
  return name || "unknown";
}

export function profileRegistrationPath(profileId) {
  return path.join(profileRegistryDir(), `${safeFileName(profileId)}.json`);
}

export function normalizeProfileRegistration(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.profileId !== "string" || value.profileId.length === 0) return null;
  if (typeof value.ipcPath !== "string" || value.ipcPath.length === 0) return null;

  return {
    version: value.version === REGISTRY_VERSION ? value.version : REGISTRY_VERSION,
    profileId: value.profileId,
    profileLabel: typeof value.profileLabel === "string" && value.profileLabel.length > 0 ? value.profileLabel : null,
    browserName: typeof value.browserName === "string" && value.browserName.length > 0 ? value.browserName : null,
    extensionId: typeof value.extensionId === "string" && value.extensionId.length > 0 ? value.extensionId : null,
    extensionVersion: typeof value.extensionVersion === "string" && value.extensionVersion.length > 0 ? value.extensionVersion : null,
    hostPid: Number.isInteger(value.hostPid) ? value.hostPid : null,
    ipcPath: value.ipcPath,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
  };
}

export function writeProfileRegistration(registration) {
  const normalized = normalizeProfileRegistration({ ...registration, version: REGISTRY_VERSION });
  if (!normalized) throw new Error("Invalid browser profile registration");

  const dir = profileRegistryDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = profileRegistrationPath(normalized.profileId);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(temp, target);
  return target;
}

export function removeProfileRegistration(profileId) {
  if (typeof profileId !== "string" || profileId.length === 0) return;
  removeProfileRegistrationFile(profileRegistrationPath(profileId));
}

export function removeProfileRegistrationFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readProfileRegistrations() {
  const dir = profileRegistryDir();
  if (!fs.existsSync(dir)) return [];

  const registrations = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const registrationPath = path.join(dir, entry.name);
    const normalized = normalizeProfileRegistration(readJsonIfPresent(registrationPath));
    if (normalized) registrations.push({ ...normalized, registrationPath });
  }
  return registrations;
}
