import { z } from "zod/mini";
import { maskIdentifier,record } from "../../../src/shared/values.ts";
import { validVersion,versionNotice } from "../../version-status.ts";
import { NativeRpc } from "./native-rpc.ts";
import type { BackgroundRuntimeDependencies as Dependencies } from "./types.ts";
type ProfileState = { profileId: string; profileLabel: string | null };

export function publicProfile<T extends Record<string, unknown>>(profile: T | null | undefined) {
  if (!profile || typeof profile !== "object") return profile;
  const { profileId, profileIdMasked, ...rest } = profile;
  const masked = typeof profileId === "string" && profileId
    ? maskIdentifier(profileId)
    : (typeof profileIdMasked === "string" ? profileIdMasked : "");
  return { ...rest, profileIdMasked: masked };
}

export function sanitizeSemanticForPopup(semantic: unknown) {
  if (!semantic || typeof semantic !== "object") return semantic;
  const { cacheDir: _cacheDir, ...rest } = record(semantic);
  return rest;
}

export function createProfileRuntime(dependencies: Dependencies) {
  const { chrome, IS_FIREFOX, PROFILE_STORAGE_KEY, VERSION_REMINDER_KEY, hostStatus, storageGet, storageSet, broadcastNativeStatus, versionCheck, acceptReconciliationToken } = dependencies;
  const rpc = dependencies.rpc as NativeRpc;
  let profileStatePromise: Promise<ProfileState> | null = null;
function randomProfileId() {
    if (globalThis.crypto?.randomUUID)
        return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function normalizeProfileLabel(label: unknown): string | null {
    if (label === null || label === undefined)
        return null;
    const normalized = String(label).replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
    return normalized.length > 0 ? normalized : null;
}
function browserNameFromUserAgent() {
    if (IS_FIREFOX)
        return "Firefox";
    const userAgent = navigator.userAgent ?? "";
    if (/Edg\//.test(userAgent))
        return "Microsoft Edge";
    if (/OPR\//.test(userAgent))
        return "Opera";
    if (/Chrome\//.test(userAgent))
        return "Chromium";
    return "Chromium-based browser";
}
async function getProfileState(): Promise<ProfileState> {
    if (profileStatePromise)
        return profileStatePromise;
    profileStatePromise = (async () => {
        const stored = (await storageGet(PROFILE_STORAGE_KEY).catch((): Record<string, unknown> => ({})))?.[PROFILE_STORAGE_KEY];
        const profile = record(stored);
        const state = {
            profileId: typeof profile.profileId === "string" && profile.profileId.length > 0 ? profile.profileId : randomProfileId(),
            profileLabel: normalizeProfileLabel(profile.profileLabel),
        };
        await storageSet({ [PROFILE_STORAGE_KEY]: state }).catch(() => { });
        return state;
    })();
    return profileStatePromise;
}
async function setProfileLabel(label: unknown) {
    const current = await getProfileState();
    const next = { ...current, profileLabel: normalizeProfileLabel(label) };
    profileStatePromise = Promise.resolve(next);
    await storageSet({ [PROFILE_STORAGE_KEY]: next });
    await announceProfile().catch(() => { });
    return profileMetadata();
}
async function profileMetadata() {
    const profile = await getProfileState();
    const manifest = chrome.runtime.getManifest();
    return {
        profileId: profile.profileId,
        profileIdMasked: maskIdentifier(profile.profileId),
        profileLabel: profile.profileLabel,
        browserName: browserNameFromUserAgent(),
        extensionId: chrome.runtime.id,
        extensionVersion: manifest.version,
    };
}
async function announceProfile() {
    const generation = ++versionCheck.generation;
    const result = await rpc.request("profile.hello", { ...await profileMetadata(), uploadConsentVersion: 1 }).catch(() => null);
    const reminder = (await storageGet(VERSION_REMINDER_KEY).catch((): Record<string, unknown> => ({})))[VERSION_REMINDER_KEY] ?? null;
    if (generation !== versionCheck.generation || hostStatus.state !== "connected")
        return;
    hostStatus.versionReminder = z.object({ key: z.string(), until: z.number() }).safeParse(reminder).data ?? null;
    acceptReconciliationToken(result);
    applyHostVersions(result);
}
function applyHostVersions(value: unknown) {
    const result = record(value);
    hostStatus.versionChecked = true;
    hostStatus.unknownClientVersion = result?.unknownClientVersion === true;
    hostStatus.nativeHostVersion = validVersion(result?.nativeHostVersion);
    hostStatus.clientVersions = Array.isArray(result?.clientVersions) ? result.clientVersions.map(validVersion).filter((version): version is string => version !== null) : [];
    broadcastNativeStatus();
}
rpc.register("host.versions", async (params) => { applyHostVersions(params); return {}; });
async function updateVersionBadge() {
    const notice = versionNotice(chrome.runtime.getManifest().version, hostStatus);
    if (!chrome.action?.setBadgeText)
        return;
    await chrome.action.setBadgeText({ text: notice && !notice.snoozed ? (notice.kind === "unknown" ? "?" : "!") : "" }).catch(() => { });
    await chrome.action.setBadgeBackgroundColor({ color: "#a86b00" }).catch(() => { });
}
  return { getProfileState, setProfileLabel, profileMetadata, publicProfile, sanitizeSemanticForPopup, announceProfile, applyHostVersions, updateVersionBadge };
}
