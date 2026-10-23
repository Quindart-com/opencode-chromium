import { isRecord } from "../shared/values.ts";
export type ImageCandidate = { mimeType: string; base64?: string; artifactId?: string; uri?: string } & Record<string, unknown>;
export function inlineImagePayload(value: unknown): (ImageCandidate & { base64: string }) | null {
  return isRecord(value) && typeof value.base64 === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/")
    ? { ...value, mimeType: value.mimeType, base64: value.base64 } : null;
}
export function* imageCandidates(value: unknown, depth = 0): Generator<ImageCandidate> {
  if (!isRecord(value) || depth > 4) return;
  const inline = inlineImagePayload(value);
  if (inline) { yield inline; return; }
  if (typeof value.mimeType === "string" && value.mimeType.startsWith("image/") && !value.base64) {
    const artifactId = typeof value.artifactId === "string" ? value.artifactId : undefined;
    const uri = typeof value.uri === "string" ? value.uri : undefined;
    if (artifactId || uri) { yield { ...value, mimeType: value.mimeType, artifactId, uri }; return; }
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const entry of child) yield* imageCandidates(entry, depth + 1);
    else if (isRecord(child)) yield* imageCandidates(child, depth + 1);
  }
}
export function sanitizeImages(value: unknown, delivery: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map(entry => sanitizeImages(entry, delivery, depth + 1));
  const inline = inlineImagePayload(value);
  if (inline) {
    const { base64, ...rest } = inline;
    return { ...rest, base64Bytes: Math.floor(base64.replace(/=+$/, "").length * 0.75), imageDelivery: delivery };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeImages(child, delivery, depth + 1)]));
}
