const RELEASE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:\.([0-9]{1,5}))?(?:-([a-zA-Z0-9.-]{1,40}))?$/;

export function validVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE.test(value);
}

export function compareVersions(first: string, second: string): number {
  const a = first.split(/[.-]/).slice(0, 4).map(Number);
  const b = second.split(/[.-]/).slice(0, 4).map(Number);
  for (let index = 0; index < 4; index++) {
    const difference = (Number.isFinite(a[index]) ? a[index]! : 0) - (Number.isFinite(b[index]) ? b[index]! : 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return validVersion(candidate) && validVersion(current) && compareVersions(candidate, current) > 0;
}

export function isMajorUpgrade(candidate: unknown, current: unknown): boolean {
  return validVersion(candidate) && validVersion(current) && Number(candidate.split(".")[0]) > Number(current.split(".")[0]);
}
