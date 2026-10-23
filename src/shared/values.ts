export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected an object");
  return value;
}
