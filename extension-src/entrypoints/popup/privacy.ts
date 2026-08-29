export function maskIdentifier(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= 8) return `${value[0]}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
