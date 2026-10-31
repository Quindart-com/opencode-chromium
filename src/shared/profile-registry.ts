import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonIfPresent } from "./node-files.ts";
import { PRODUCT } from "./product.ts";
import { record } from "./values.ts";
const REGISTRY_VERSION = 1;
export function profileRegistryDir() { const configured = process.env.AGENT_BROWSER_PROFILE_REGISTRY_DIR ?? process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR; return configured ? path.resolve(configured) : path.join(os.tmpdir(), "agent-browser-profiles"); }
function safeFileName(value: unknown) { return String(value ?? "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "unknown"; }
export function profileRegistrationPath(profileId: string) { return path.join(profileRegistryDir(), `${safeFileName(profileId)}.json`); }
export function normalizeProfileRegistration(input: unknown) {
  const value = record(input); if (typeof value.profileId !== "string" || !value.profileId || typeof value.ipcPath !== "string" || !value.ipcPath) return null;
  return { version: REGISTRY_VERSION,plugin: PRODUCT.pluginId,protocolVersion: String(value.protocolVersion ?? "1"),profileId: value.profileId,profileFingerprint: typeof value.profileFingerprint === "string" && value.profileFingerprint ? value.profileFingerprint : value.profileId,connectionId: typeof value.connectionId === "string" && value.connectionId ? value.connectionId : null,connectionGeneration: typeof value.connectionGeneration === "number" && Number.isInteger(value.connectionGeneration) ? value.connectionGeneration : 1,profileLabel: typeof value.profileLabel === "string" && value.profileLabel ? value.profileLabel : null,browserName: typeof value.browserName === "string" && value.browserName ? value.browserName : null,browserVersion: typeof value.browserVersion === "string" && value.browserVersion ? value.browserVersion : null,extensionId: typeof value.extensionId === "string" && value.extensionId ? value.extensionId : null,extensionVersion: typeof value.extensionVersion === "string" && value.extensionVersion ? value.extensionVersion : null,hostPid: typeof value.hostPid === "number" && Number.isInteger(value.hostPid) ? value.hostPid : null,ipcPath: value.ipcPath,startedAt: typeof value.startedAt === "string" ? value.startedAt : null,lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null };
}
export function writeProfileRegistration(registration: unknown) { const normalized = normalizeProfileRegistration({ ...record(registration),version: REGISTRY_VERSION }); if (!normalized) throw new Error("Invalid browser profile registration"); const dir = profileRegistryDir(); fs.mkdirSync(dir, { recursive: true }); const target = profileRegistrationPath(normalized.profileId),temp = `${target}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), "utf8"); fs.renameSync(temp, target); return target; }
export function removeProfileRegistration(profileId: unknown) { if (typeof profileId === "string" && profileId) removeProfileRegistrationFile(profileRegistrationPath(profileId)); }
export function removeProfileRegistrationFile(filePath: fs.PathLike) { try { fs.unlinkSync(filePath); } catch (error) { if (record(error).code !== "ENOENT") throw error; } }
export function readProfileRegistrations(dir = profileRegistryDir()) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).flatMap(entry => { const registrationPath = path.join(dir, entry.name),normalized = normalizeProfileRegistration(readJsonIfPresent(registrationPath)); return normalized ? [{ ...normalized,registrationPath }] : []; }); }
export type ProfileRegistration = NonNullable<ReturnType<typeof normalizeProfileRegistration>> & { registrationPath?: string };
