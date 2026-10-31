import { record } from "../../../src/shared/values.ts";

type Dependencies = { downloadEvents: { recordInline(tabId: number, id: string, event: Record<string, unknown>): unknown }; inlineResponseEventKeys: Set<string>; maxInlineResponseKeys: number };

export function createInlineResponseRecorder({ downloadEvents, inlineResponseEventKeys, maxInlineResponseKeys }: Dependencies) {
function headerValue(headers: unknown, name: string): unknown {
    if (!headers || typeof headers !== "object")
        return null;
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(record(headers))) {
        if (key.toLowerCase() === expected)
            return Array.isArray(value) ? value[0] : value;
    }
    return null;
}
function filenameFromDisposition(disposition: unknown): string | null {
    if (typeof disposition !== "string")
        return null;
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded);
        }
        catch {
            return encoded;
        }
    }
    return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}
function recordInlineBrowserResponse(tabId: number, method: string, params: unknown) {
    if (method !== "Network.responseReceived")
        return;
    const event = record(params);
    const response = record(event.response);
    const mime = String(response?.mimeType ?? headerValue(response?.headers, "content-type") ?? "").toLowerCase();
    if (!mime.includes("application/pdf"))
        return;
    const url = response?.url ?? event.documentURL ?? null;
    const key = `${tabId}:${event.requestId ?? inlineResponseEventKeys.size}`;
    if (inlineResponseEventKeys.has(key))
        return;
    inlineResponseEventKeys.add(key);
    if (inlineResponseEventKeys.size > maxInlineResponseKeys)
        inlineResponseEventKeys.delete(inlineResponseEventKeys.values().next().value ?? "");
    const totalBytes = Number(headerValue(response?.headers, "content-length"));
    downloadEvents.recordInline(tabId, `inline:${key}`, {
        url,
        finalUrl: url,
        filename: filenameFromDisposition(headerValue(response?.headers, "content-disposition")),
        mime: response?.mimeType ?? "application/pdf",
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        bytesReceived: null,
        danger: null,
        error: null,
    });
}
  return recordInlineBrowserResponse;
}
