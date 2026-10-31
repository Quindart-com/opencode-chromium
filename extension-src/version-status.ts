import { compareVersions,validVersion as isValidVersion } from "../src/shared/semver.ts";

export type VersionStatus = {
  state?: string;
  versionChecked?: boolean;
  nativeHostVersion?: string | null;
  clientVersions?: string[];
  unknownClientVersion?: boolean;
  browserCompatible?: boolean;
  browserContractVersion?: number;
  runtimeBrowserContractVersions?: number[];
  versionReminder?: { key: string; until: number } | null;
};

export function validVersion(value: unknown): string | null {
  return isValidVersion(value) ? value : null;
}
export function versionNotice(extension: string, status: VersionStatus) {
  if (status.state !== "connected" || !status.versionChecked) return null;
  if (status.browserCompatible === true && !status.unknownClientVersion) return null;
  const host = validVersion(status.nativeHostVersion);
  const clients = [...new Set((status.clientVersions ?? []).map(validVersion).filter((item): item is string => item !== null))].sort();
  if (!status.unknownClientVersion && host === extension && clients.every((version) => version === extension)) return null;
  const versions = [host, ...clients].filter((item): item is string => item !== null);
  const kind = !host || status.unknownClientVersion ? "unknown" : versions.some((version) => compareVersions(version, extension) > 0) ? "extension" : "local";
  // Reconnecting matching clients must not reset a snoozed host warning.
  const otherMismatches = clients.filter((version) => version !== extension && version !== host);
  const key = JSON.stringify([extension, host, otherMismatches, status.unknownClientVersion === true]);
  return { key, kind, host, clients, snoozed: status.versionReminder?.key === key && status.versionReminder.until > Date.now() };
}
