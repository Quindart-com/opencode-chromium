import { randomUUID } from "node:crypto";
import { telemetryBatchSchema } from "../shared/telemetry-schema.ts";

export interface CollectorConfig { measurementId: string; apiSecret: string; fetcher?: typeof fetch }

/** Deploy behind a request-size limit and infrastructure rate limiting; never log request bodies or IPs. */
export function createTelemetryCollector(config: CollectorConfig) {
  const fetcher = config.fetcher ?? fetch;
  return async function handle(request: Request): Promise<Response> {
    const respond = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST") return respond(405);
    if (new URL(request.url).pathname !== "/v1/diagnostics") return respond(404);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return respond(415);
    if (!/^G-[A-Z0-9]+$/.test(config.measurementId) || !config.apiSecret) return respond(503);
    if (Number(request.headers.get("content-length")) > 24000) return respond(413);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of request.body ?? []) {
        size += chunk.byteLength;
        if (size > 24000) return respond(413);
        chunks.push(chunk);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { return respond(400); }
      const batch = telemetryBatchSchema.safeParse(input);
      if (!batch.success) return respond(400);
      const endpoint = new URL("https://region1.google-analytics.com/mp/collect");
      endpoint.searchParams.set("measurement_id", config.measurementId);
      endpoint.searchParams.set("api_secret", config.apiSecret);
      const payload = {
        // New identity per batch, created here: no client or installation identifier is accepted.
        client_id: randomUUID(),
        consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
        events: batch.data.events.map(({ dimensions, count }) => ({
          name: dimensions.tool === "runtime" ? "runtime_health" : "tool_outcome",
          params: { ...dimensions, occurrences: count, schema_version: 1 },
        })),
      };
      const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1500), redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      await response.body?.cancel();
      return respond(response.ok ? 204 : 502);
    } catch { return respond(502); }
  };
}
