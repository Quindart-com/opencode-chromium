import { z } from "zod";
import { redact } from "../core/logging.ts";
import type { NETWORK_INSPECT_ARGS } from "../core/network-capability.ts";
import { record as object } from "../shared/values.ts";
type NetworkOptions = Partial<Omit<z.output<z.ZodObject<typeof NETWORK_INSPECT_ARGS>>, "tabId" | "methods" | "resourceTypes">> & { methods?: string[] | Set<string>; resourceTypes?: string[] | Set<string> };
type HeaderValue = string | null | HeaderValue[];
type SafeHeaders = Record<string, HeaderValue> | null;
type BodyOptions = { base64Encoded?: boolean; mimeType?: string | null };
type FetchedBody = { body?: unknown; base64Encoded?: boolean; error?: string | null; unavailable?: boolean };
type BodyFetcher = { getRequestBody?(id: string): Promise<unknown>; getResponseBody?(id: string): Promise<unknown> };
const responseSchema = z.looseObject({ url: z.string().optional(), status: z.number().optional(), statusText: z.string().optional(), mimeType: z.string().optional(), headers: z.record(z.string(), z.unknown()).optional(),
  timing: z.record(z.string(), z.unknown()).optional(), fromDiskCache: z.boolean().optional(), fromPrefetchCache: z.boolean().optional(), fromServiceWorker: z.boolean().optional() });
const eventSchema = z.object({ method: z.string(), time: z.union([z.string(), z.number()]).optional(), params: z.looseObject({
  requestId: z.union([z.string(), z.number()]).optional(), identifier: z.union([z.string(), z.number()]).optional(), timestamp: z.number().optional(),
  request: z.object({ url: z.string().optional(), method: z.string().optional(), headers: z.record(z.string(), z.unknown()).optional(), postData: z.string().optional() }).optional(),
  response: responseSchema.optional(), redirectResponse: responseSchema.optional(), documentURL: z.string().optional(), type: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(), statusCode: z.number().optional(), encodedDataLength: z.number().optional(), dataLength: z.number().optional(),
  errorText: z.string().optional(), blockedReason: z.string().optional(), corsErrorStatus: z.object({ corsError: z.string().optional() }).optional(), canceled: z.boolean().optional(),
  url: z.string().optional(), errorMessage: z.string().optional(),
}) });
type NetworkEvent = z.output<typeof eventSchema>;
interface NetworkRecord {
  requestId: string; order: number; url: string | null; method: string | null; resourceType: string | null; lifecycle: string;
  status: number | null; statusText: string | null; mimeType: string | null;
  requestAt: string | number | null; responseAt: string | number | null; finishedAt: string | number | null;
  requestTimestamp: number | null; responseTimestamp: number | null; finishedTimestamp: number | null;
  requestHeaders: SafeHeaders; responseHeaders: SafeHeaders; timing: Record<string, number | null> | null;
  fromCache: boolean; fromServiceWorker: boolean; dataLength: number; encodedDataLength: number; hasDataLength: boolean; hasEncodedDataLength: boolean;
  error: string | null; redirects: ReturnType<typeof redirectSummary>[]; requestPostData?: string;
  webSocketFramesSent: number; webSocketFramesReceived: number; webSocketFrameError: string | null;
}
type PublicNetworkRecord = Pick<NetworkRecord, "requestId" | "url" | "method" | "resourceType" | "lifecycle" | "status" | "statusText" | "mimeType" | "requestAt" | "responseAt" | "finishedAt"> & {
  cdpTimestamps?: { request?: number; response?: number; finished?: number }; timing?: Record<string, number | null>;
  sizes?: { dataLength?: number; encodedDataLength?: number }; fromCache?: boolean; fromServiceWorker?: boolean; error?: string;
  redirects?: NetworkRecord["redirects"]; requestHeaders?: SafeHeaders; responseHeaders?: SafeHeaders;
  webSocket?: { framesSent: number; framesReceived: number; frameError?: string };
  requestBodyError?: string | null; responseBodyError?: string | null; requestBodyRaw?: string; responseBodyRaw?: string;
  requestBody?: ReturnType<typeof networkBodyPreview>; responseBody?: ReturnType<typeof networkBodyPreview>;
};

const REDACTION_MARKER = "[REDACTED]";

const SENSITIVE_QUERY_KEY = /^(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|key|secret|password|passcode|auth|authorization|code|signature|sig)$/i;
const SENSITIVE_HEADER_KEY = /(?:authorization|cookie|set-cookie|token|secret|password|passcode|api[-_]?key|proxy-authorization|x-auth)/i;
const SENSITIVE_TEXT_FIELD = /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|passcode|authorization|cookie|signature|sig)\s*[=:]\s*["']?)([^&\s,;}'"]+)/gi;
const BINARY_MIME = /^(?:image\/|audio\/|video\/|font\/|application\/(?:pdf|zip|gzip|octet-stream|wasm|x-rar-compressed))/i;
const MAX_HEADERS = 80;
const MAX_HEADER_VALUE = 1200;
const MAX_BODY_FETCHES = 20;

function normalizeResourceType(value: string|null|undefined) {
  if (value === undefined || value === null || value === "") return null;
  const type = String(value).toLocaleLowerCase();
  return ["preflight", "ping", "signedexchange", "cspviolationreport"].includes(type) ? "other" : type;
}

function clipped(value: unknown, limit = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function eventTime(event: NetworkEvent, params: NetworkEvent["params"]) {
  return event?.time ?? params?.timestamp ?? null;
}

export function safeNetworkUrl(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.username) url.username = REDACTION_MARKER;
    if (url.password) url.password = REDACTION_MARKER;
    for (const [key] of url.searchParams) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return String(redact(url.toString(), { key: "url" })).replace(SENSITIVE_TEXT_FIELD, "$1[REDACTED]");
  } catch {
    return String(redact(value.split("#", 1)[0] ?? "", { key: "url" })).replace(SENSITIVE_TEXT_FIELD, "$1[REDACTED]");
  }
}

function safeHeaderValue(name: string, value: unknown): HeaderValue {
  if (SENSITIVE_HEADER_KEY.test(name)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeHeaderValue(name, item));
  return clipped(redact(value, { key: name }), MAX_HEADER_VALUE);
}

export function safeNetworkHeaders(headers: unknown): SafeHeaders {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const entries = Object.entries(headers).slice(0, MAX_HEADERS);
  const output = Object.fromEntries(entries.map(([name, value]) => [name, safeHeaderValue(name, value)]));
  if (Object.keys(headers).length > entries.length) output["[additional headers]"] = `[${Object.keys(headers).length - entries.length} omitted]`;
  return output;
}

function safeTiming(timing: unknown) {
  if (!timing || typeof timing !== "object") return null;
  const output: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(timing).slice(0, 40)) {
    if (typeof value === "number" || value === null) output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function isBinaryBody(mimeType: string | null) {
  return typeof mimeType === "string" && BINARY_MIME.test(mimeType);
}

export function networkBodyPreview(value: unknown, maxChars = 4000, options: BodyOptions = {}) {
  if (value === undefined || value === null) return null;
  const raw = String(value);
  const mimeType = options.mimeType ?? null;
  if (options.base64Encoded === true || isBinaryBody(mimeType)) {
    return {
      mimeType,
      encoding: options.base64Encoded === true ? "base64" : "binary",
      length: raw.length,
      preview: "[binary body omitted]",
      truncated: true,
    };
  }

  let safe;
  try {
    safe = JSON.stringify(redact((JSON.parse(raw) as unknown), { key: "payload" })) ?? "";
  } catch {
    safe = String(redact(raw, { key: "payload" })).replace(SENSITIVE_TEXT_FIELD, "$1[REDACTED]");
  }
  const preview = clipped(safe, maxChars) ?? "";
  return {
    mimeType,
    length: raw.length,
    preview,
    truncated: preview.length < safe.length,
  };
}

export function networkBodyRedacted(value: unknown, options: BodyOptions = {}) {
  if (value === undefined || value === null) return null;
  const raw = String(value);
  const mimeType = options.mimeType ?? null;
  if (options.base64Encoded === true || isBinaryBody(mimeType)) {
    return null;
  }
  try {
    return JSON.stringify(redact((JSON.parse(raw) as unknown), { key: "payload" }));
  } catch {
    return String(redact(raw, { key: "payload" })).replace(SENSITIVE_TEXT_FIELD, "$1[REDACTED]");
  }
}

function recordFor(records: Map<string, NetworkRecord>, requestId: string | number, order: number): NetworkRecord {
  const key = String(requestId);
  let record = records.get(key);
  if (record) return record;
  record = {
    requestId: key,
    order,
    url: null,
    method: null,
    resourceType: null,
    lifecycle: "pending",
    status: null,
    statusText: null,
    mimeType: null,
    requestAt: null,
    responseAt: null,
    finishedAt: null,
    requestTimestamp: null,
    responseTimestamp: null,
    finishedTimestamp: null,
    requestHeaders: null,
    responseHeaders: null,
    timing: null,
    fromCache: false,
    fromServiceWorker: false,
    dataLength: 0,
    encodedDataLength: 0,
    hasDataLength: false,
    hasEncodedDataLength: false,
    error: null,
    redirects: [],
    requestPostData: undefined,
    webSocketFramesSent: 0,
    webSocketFramesReceived: 0,
    webSocketFrameError: null,
  };
  records.set(key, record);
  return record;
}

function redirectSummary(redirect: { url?: string | null; status?: number; statusText?: string; mimeType?: string; headers?: Record<string, unknown> }) {
  return {
    url: safeNetworkUrl(redirect?.url),
    status: redirect.status !== undefined && Number.isFinite(redirect.status) ? redirect.status : null,
    statusText: clipped(redirect?.statusText, 160),
    mimeType: clipped(redirect?.mimeType, 160),
    location: safeNetworkUrl(redirect?.headers?.location ?? redirect?.headers?.Location),
  };
}

function collectNetworkRecords(events: unknown, options: NetworkOptions = {}) {
  const records = new Map<string, NetworkRecord>();
  const includeHeaders = options.includeHeaders === true;
  const includeBody = options.includeBody ?? "none";
  for (const [order, raw] of (Array.isArray(events) ? events : []).entries()) {
    const parsed = eventSchema.safeParse(raw); if (!parsed.success) continue;
    const event = parsed.data;
    const method = event?.method;
    const params = event?.params ?? {};
    const requestId = params.requestId ?? params.identifier;
    if (requestId === undefined || requestId === null) continue;
    const record = recordFor(records, requestId, order);
    const time = eventTime(event, params);

    if (method === "Network.requestWillBeSent") {
      const request = params.request ?? {};
      if (params.redirectResponse) {
        record.redirects.push(redirectSummary({
          url: record.url ?? params.redirectResponse.url,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          mimeType: params.redirectResponse.mimeType,
          headers: params.redirectResponse.headers,
        }));
      }
      record.url = safeNetworkUrl(request.url ?? params.documentURL ?? record.url);
      record.method = request.method ?? record.method;
      record.resourceType = normalizeResourceType(params.type) ?? record.resourceType;
      record.requestAt = record.requestAt ?? time;
      record.requestTimestamp = record.requestTimestamp ?? params.timestamp ?? null;
      if (includeHeaders && request.headers) record.requestHeaders = safeNetworkHeaders(request.headers);
      if (includeBody && ["request", "both"].includes(includeBody) && request.postData !== undefined) {
        record.requestPostData = request.postData;
      }
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      if (includeHeaders && params.headers) record.requestHeaders = safeNetworkHeaders(params.headers);
    } else if (method === "Network.responseReceived") {
      const response = params.response ?? {};
      record.url = safeNetworkUrl(response.url ?? record.url);
      record.resourceType = normalizeResourceType(params.type) ?? record.resourceType;
      record.status = response.status !== undefined && Number.isFinite(response.status) ? response.status : record.status;
      record.statusText = clipped(response.statusText, 160) ?? record.statusText;
      record.mimeType = clipped(response.mimeType, 160) ?? record.mimeType;
      record.responseAt = record.responseAt ?? time;
      record.responseTimestamp = record.responseTimestamp ?? params.timestamp ?? null;
      if (includeHeaders && response.headers) record.responseHeaders = safeNetworkHeaders(response.headers);
      record.timing = safeTiming(response.timing) ?? record.timing;
      record.fromCache ||= response.fromDiskCache === true || response.fromPrefetchCache === true;
      record.fromServiceWorker ||= response.fromServiceWorker === true;
      if (record.lifecycle !== "failed" && record.lifecycle !== "closed") record.lifecycle = "response";
    } else if (method === "Network.responseReceivedExtraInfo") {
      if (params.statusCode !== undefined && Number.isFinite(params.statusCode)) record.status = params.statusCode;
      if (includeHeaders && params.headers) record.responseHeaders = safeNetworkHeaders(params.headers);
    } else if (method === "Network.loadingFinished") {
      record.finishedAt = record.finishedAt ?? time;
      record.finishedTimestamp = record.finishedTimestamp ?? params.timestamp ?? null;
      if (params.encodedDataLength !== undefined && Number.isFinite(params.encodedDataLength)) {
        record.encodedDataLength = params.encodedDataLength;
        record.hasEncodedDataLength = true;
      }
      if (record.lifecycle !== "failed" && record.lifecycle !== "closed") record.lifecycle = "finished";
    } else if (method === "Network.loadingFailed") {
      record.finishedAt = record.finishedAt ?? time;
      record.finishedTimestamp = record.finishedTimestamp ?? params.timestamp ?? null;
      record.error = clipped(params.errorText ?? params.blockedReason ?? params.corsErrorStatus?.corsError, 300);
      if (params.canceled === true && !record.error) record.error = "canceled";
      record.lifecycle = "failed";
    } else if (method === "Network.dataReceived") {
      if (params.dataLength !== undefined && Number.isFinite(params.dataLength)) {
        record.dataLength += params.dataLength;
        record.hasDataLength = true;
      }
      if (params.encodedDataLength !== undefined && Number.isFinite(params.encodedDataLength)) {
        record.encodedDataLength += params.encodedDataLength;
        record.hasEncodedDataLength = true;
      }
    } else if (method === "Network.requestServedFromCache") {
      record.fromCache = true;
    } else if (method === "Network.webSocketCreated") {
      record.url = safeNetworkUrl(params.url ?? record.url);
      record.method = "GET";
      record.resourceType = "websocket";
      record.requestAt = record.requestAt ?? time;
      record.requestTimestamp = record.requestTimestamp ?? params.timestamp ?? null;
    } else if (method === "Network.webSocketWillSendHandshakeRequest") {
      record.requestAt = record.requestAt ?? time;
      record.method = record.method ?? "GET";
      record.resourceType = record.resourceType ?? "websocket";
    } else if (method === "Network.webSocketHandshakeResponseReceived") {
      const response = params.response ?? {};
      record.status = response.status !== undefined && Number.isFinite(response.status) ? response.status : record.status;
      record.statusText = clipped(response.statusText, 160) ?? record.statusText;
      record.responseAt = record.responseAt ?? time;
      record.responseTimestamp = record.responseTimestamp ?? params.timestamp ?? null;
      if (includeHeaders && response.headers) record.responseHeaders = safeNetworkHeaders(response.headers);
      record.resourceType = "websocket";
      record.lifecycle = "response";
    } else if (method === "Network.webSocketFrameSent") {
      record.webSocketFramesSent += 1;
    } else if (method === "Network.webSocketFrameReceived") {
      record.webSocketFramesReceived += 1;
    } else if (method === "Network.webSocketFrameError") {
      record.webSocketFrameError = clipped(params.errorMessage, 300);
    } else if (method === "Network.webSocketClosed") {
      record.finishedAt = record.finishedAt ?? time;
      record.finishedTimestamp = record.finishedTimestamp ?? params.timestamp ?? null;
      if (record.lifecycle !== "failed") record.lifecycle = "closed";
    }
  }
  return [...records.values()].sort((first, second) => first.order - second.order);
}

function matchesNetworkFilter(record: NetworkRecord, options: NetworkOptions) {
  if (options.requestId !== undefined && String(record.requestId) !== String(options.requestId)) return false;
  const urlIncludes = typeof options.urlIncludes === "string" ? options.urlIncludes.toLocaleLowerCase() : null;
  if (urlIncludes && !String(record.url ?? "").toLocaleLowerCase().includes(urlIncludes)) return false;
  const methods = options.methods instanceof Set
    ? options.methods
    : new Set((options.methods ?? []).map((method: string) => String(method).toLocaleUpperCase()));
  if (methods.size > 0 && !methods.has(String(record.method ?? "").toLocaleUpperCase())) return false;
  const resourceTypes = options.resourceTypes instanceof Set
    ? options.resourceTypes
    : new Set((options.resourceTypes ?? []).map((type: string) => String(type).toLocaleLowerCase()));
  if (resourceTypes.size > 0 && !resourceTypes.has(String(record.resourceType ?? "").toLocaleLowerCase())) return false;
  if (options.statusMin !== undefined && (record.status === null || !Number.isFinite(record.status) || record.status < options.statusMin)) return false;
  if (options.statusMax !== undefined && (record.status === null || !Number.isFinite(record.status) || record.status > options.statusMax)) return false;
  return true;
}

function publicNetworkRecord(record: NetworkRecord, options: NetworkOptions): PublicNetworkRecord {
  const output: PublicNetworkRecord = {
    requestId: record.requestId,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    lifecycle: record.lifecycle,
    status: record.status,
    statusText: record.statusText,
    mimeType: record.mimeType,
    requestAt: record.requestAt,
    responseAt: record.responseAt,
    finishedAt: record.finishedAt,
  };
  if (options.includeTiming !== false) {
    const timestamps: { request?: number; response?: number; finished?: number } = {};
    if (record.requestTimestamp !== null) timestamps.request = record.requestTimestamp;
    if (record.responseTimestamp !== null) timestamps.response = record.responseTimestamp;
    if (record.finishedTimestamp !== null) timestamps.finished = record.finishedTimestamp;
    if (Object.keys(timestamps).length > 0) output.cdpTimestamps = timestamps;
    if (record.timing) output.timing = record.timing;
  }
  if (record.hasDataLength || record.hasEncodedDataLength) {
    output.sizes = {
      ...(record.hasDataLength ? { dataLength: record.dataLength } : {}),
      ...(record.hasEncodedDataLength ? { encodedDataLength: record.encodedDataLength } : {}),
    };
  }
  if (record.fromCache) output.fromCache = true;
  if (record.fromServiceWorker) output.fromServiceWorker = true;
  if (record.error) output.error = record.error;
  if (record.redirects.length > 0) output.redirects = record.redirects;
  if (options.includeHeaders === true) {
    if (record.requestHeaders) output.requestHeaders = record.requestHeaders;
    if (record.responseHeaders) output.responseHeaders = record.responseHeaders;
  }
  if (record.resourceType === "websocket" && (record.webSocketFramesSent || record.webSocketFramesReceived || record.webSocketFrameError)) {
    output.webSocket = {
      framesSent: record.webSocketFramesSent,
      framesReceived: record.webSocketFramesReceived,
      ...(record.webSocketFrameError ? { frameError: record.webSocketFrameError } : {}),
    };
  }
  return output;
}

function bodyResult(value: unknown): FetchedBody {
  if (value && typeof value === "object" && ("body" in value || "postData" in value)) {
    return {
      body: object(value).body ?? object(value).postData,
      base64Encoded: object(value).base64Encoded === true,
    };
  }
  return { body: value, base64Encoded: false };
}

async function fetchBody(fetcher: BodyFetcher, kind: string, requestId: string): Promise<FetchedBody> {
  const method = kind === "request" ? "getRequestBody" : "getResponseBody";
  if (typeof fetcher?.[method] !== "function") return { unavailable: true };
  try {
    const call = fetcher[method];
    if (!call) return { unavailable: true };
    return bodyResult(await call(requestId));
  } catch (error) {
    return { error: clipped(error instanceof Error ? error.message : String(error), 300) };
  }
}

export async function inspectNetworkEvents(events: unknown, options: NetworkOptions = {}, fetcher: BodyFetcher = {}) {
  const normalized = {
    limit: options.limit !== undefined && Number.isInteger(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50,
    includeHeaders: options.includeHeaders === true,
    includeBody: options.includeBody ?? "none",
    bodyDelivery: options.bodyDelivery ?? "inline",
    bodyMaxChars: options.bodyMaxChars !== undefined && Number.isInteger(options.bodyMaxChars) ? Math.max(1, Math.min(options.bodyMaxChars, 12000)) : 4000,
    includeTiming: options.includeTiming !== false,
    urlIncludes: options.urlIncludes,
    methods: options.methods,
    resourceTypes: options.resourceTypes,
    statusMin: options.statusMin,
    statusMax: options.statusMax,
    requestId: options.requestId,
  };
  const all = collectNetworkRecords(events, normalized).filter((record) => matchesNetworkFilter(record, normalized));
  const selectedRecords = all.slice(-normalized.limit);
  const outputEvents = selectedRecords.map((record) => publicNetworkRecord(record, normalized));
  let bodyFetches = 0;
  let bodyFetchLimited = false;

  if (normalized.includeBody !== "none") {
    for (const [index, record] of selectedRecords.entries()) {
      const output = outputEvents[index];
      if (!output) continue;
      const artifactDelivery = normalized.bodyDelivery === "artifact";
      if (["request", "both"].includes(normalized.includeBody)) {
        let requestBody: FetchedBody | null = record.requestPostData !== undefined
          ? { body: record.requestPostData, base64Encoded: false }
          : null;
        if (!requestBody && bodyFetches < MAX_BODY_FETCHES) {
          bodyFetches += 1;
          requestBody = await fetchBody(fetcher, "request", record.requestId);
        } else if (!requestBody && typeof fetcher.getRequestBody === "function") {
          bodyFetchLimited = true;
        }
        if (requestBody?.error) output.requestBodyError = requestBody.error;
        else if (requestBody?.unavailable) output.requestBodyError = "request body fetch unavailable";
        else if (requestBody?.body !== undefined) {
          if (artifactDelivery) {
            const redacted = networkBodyRedacted(requestBody.body, { base64Encoded: requestBody.base64Encoded, mimeType: record.mimeType });
            if (redacted !== null) output.requestBodyRaw = redacted;
            else output.requestBody = networkBodyPreview(requestBody.body, normalized.bodyMaxChars, { base64Encoded: requestBody.base64Encoded, mimeType: record.mimeType });
          } else {
            output.requestBody = networkBodyPreview(requestBody.body, normalized.bodyMaxChars, {
              base64Encoded: requestBody.base64Encoded,
              mimeType: record.mimeType,
            });
          }
        }
      }
      if (["response", "both"].includes(normalized.includeBody)) {
        let responseBody: FetchedBody | null = null;
        if (bodyFetches < MAX_BODY_FETCHES) {
          bodyFetches += 1;
          responseBody = await fetchBody(fetcher, "response", record.requestId);
        } else if (typeof fetcher.getResponseBody === "function") {
          bodyFetchLimited = true;
        }
        if (responseBody?.error) output.responseBodyError = responseBody.error;
        else if (responseBody?.unavailable) output.responseBodyError = "response body fetch unavailable";
        else if (responseBody?.body !== undefined) {
          if (artifactDelivery) {
            const redacted = networkBodyRedacted(responseBody.body, { base64Encoded: responseBody.base64Encoded, mimeType: record.mimeType });
            if (redacted !== null) output.responseBodyRaw = redacted;
            else output.responseBody = networkBodyPreview(responseBody.body, normalized.bodyMaxChars, { base64Encoded: responseBody.base64Encoded, mimeType: record.mimeType });
          } else {
            output.responseBody = networkBodyPreview(responseBody.body, normalized.bodyMaxChars, {
              base64Encoded: responseBody.base64Encoded,
              mimeType: record.mimeType,
            });
          }
        }
      }
    }
  }

  return {
    totalEvents: Array.isArray(events) ? events.length : 0,
    totalRequests: all.length,
    returned: outputEvents.length,
    truncated: all.length > outputEvents.length,
    ...(normalized.includeBody !== "none" ? { bodyFetches, bodyFetchLimit: MAX_BODY_FETCHES, bodyFetchLimited } : {}),
    events: outputEvents,
  };
}

export function shapeNetworkInspection(events: unknown, options: NetworkOptions = {}) {
  return inspectNetworkEvents(events, { ...options, includeBody: "none" });
}
