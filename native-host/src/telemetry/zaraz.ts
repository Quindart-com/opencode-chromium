import { randomUUID } from "node:crypto";
import { telemetryBatchSchema } from "../../../src/shared/telemetry-schema.ts";

/** Zaraz HTTP Events API. Returned cookies, scripts and fetch instructions are never executed. */
export function zarazPayload(input: unknown, endpoint: string) {
  const batch = telemetryBatchSchema.parse(input);
  const cid = randomUUID();
  const page = { url: new URL(endpoint).origin + "/", title: "OpenCode Browser Diagnostics", referrer: "" };
  return { events: batch.events.map(({ dimensions, count }) => ({
    client: { __zarazTrack: dimensions.tool === "runtime" ? "opencode_runtime_health" : "opencode_tool_outcome",
      ...dimensions, occurrences: count, schema_version: 1, cid },
    system: { cookies: {}, page, device: { "user-agent": "OpenCodeBrowserDiagnostics/1" } },
  })) };
}
