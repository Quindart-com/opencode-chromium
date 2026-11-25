import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeDirectory } from "../control/state.ts";

export function telemetryDirectory() { return path.join(runtimeDirectory(), "diagnostics"); }
export function telemetryPreference(directory = telemetryDirectory()) {
  let enabled = true, generation = "initial";
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
    if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean" || !("generation" in value) || typeof value.generation !== "string") return { enabled: false, generation: "invalid" };
    enabled = value.enabled; generation = value.generation;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { enabled: false, generation: "unavailable" }; }
  return { enabled: enabled && process.env.OPENCODE_BROWSER_TELEMETRY !== "0" && process.env.DO_NOT_TRACK !== "1", generation };
}
export function setTelemetryPreference(enabled: boolean, directory = telemetryDirectory()) {
  if (typeof enabled !== "boolean") throw new Error("Diagnostics enabled must be a boolean");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "settings.json"), temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ enabled, generation: randomUUID() }), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or unavailable. */ } }
  return telemetryPreference(directory);
}
