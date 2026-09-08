export type VersionStatus = {
  state?: string;
  versionChecked?: boolean;
  nativeHostVersion?: string | null;
  clientVersions?: string[];
  unknownClientVersion?: boolean;
  versionReminder?: { key: string; until: number } | null;
};

export function validVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?(?:-[a-zA-Z0-9.-]{1,40})?$/.test(value) ? value : null;
}

function compare(first: string, second: string): number {
  const a = first.split(/[.-]/).slice(0, 4).map(Number);
  const b = second.split(/[.-]/).slice(0, 4).map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (Number.isFinite(a[i]) ? a[i]! : 0) - (Number.isFinite(b[i]) ? b[i]! : 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function versionNotice(extension: string, status: VersionStatus) {
  if (status.state !== "connected" || !status.versionChecked) return null;
  const host = validVersion(status.nativeHostVersion);
  const clients = [...new Set((status.clientVersions ?? []).map(validVersion).filter((item): item is string => item !== null))].sort();
  if (!status.unknownClientVersion && host === extension && clients.every((version) => version === extension)) return null;
  const versions = [host, ...clients].filter((item): item is string => item !== null);
  const kind = !host || status.unknownClientVersion ? "unknown" : versions.some((version) => compare(version, extension) > 0) ? "extension" : "local";
  const key = JSON.stringify([extension, host, clients, status.unknownClientVersion === true]);
  return { key, kind, host, clients, snoozed: status.versionReminder?.key === key && status.versionReminder.until > Date.now() };
}
