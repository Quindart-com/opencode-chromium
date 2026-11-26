import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CallMeasurement } from "../core/telemetry.ts";
import { approvalStateSchema,dispatchStateSchema,telemetryDimensionsSchema,telemetryEnvironment,telemetrySampleSchema,telemetryStageSchema } from "../shared/telemetry-schema.ts";
import { telemetryDirectory,telemetryPreference } from "./settings.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 32, MAX_FILE_ROWS = 512, MAX_QUEUE_ROWS = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_PATTERN = /^calls-(\d{13})-[a-f0-9-]{36}\.jsonl$/;
const eventSchema = z.strictObject({
  sample: telemetrySampleSchema,
  browser_family: telemetryDimensionsSchema.shape.browser_family,
  browser_major: telemetryDimensionsSchema.shape.browser_major,
  at: z.number().int().min(0).max(8_640_000_000_000_000),
  duration_ms: z.number().min(0),
  request_json_bytes: z.number().int().min(0),
  response_json_bytes: z.number().int().min(0),
  dispatch: dispatchStateSchema.optional(),
  approval: approvalStateSchema.optional(),
  stages_ms: z.partialRecord(telemetryStageSchema, z.number().min(0)),
});
const rowSchema = z.tuple([z.string(), eventSchema]);
type LocalEvent = z.output<typeof eventSchema>;
type Row = z.output<typeof rowSchema>;

function jsonBytes(value: unknown) {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); }
  catch { return 0; }
}

async function callFiles(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - RETENTION_MS;
  const names = entries.filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name)).map(entry => entry.name).sort().reverse();
  return {
    retained: names.filter(name => Number(FILE_PATTERN.exec(name)?.[1]) >= cutoff).slice(0, MAX_FILES),
    excess: names.filter((name, index) => index >= MAX_FILES || Number(FILE_PATTERN.exec(name)?.[1]) < cutoff),
  };
}

export function createLocalDiagnostics(directory: string) {
  const folder = path.join(directory, "calls");
  let queue: Row[] = [], file: string | undefined, count = 0, createdAt = 0, generation: string | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined, writing: Promise<void> | undefined;

  function schedule() {
    if (scheduled || writing || !queue.length) return;
    scheduled = setImmediate(() => { scheduled = undefined; void flush(); });
  }

  async function persist(rows: Row[]) {
    const preference = telemetryPreference(directory);
    if (!preference.enabled) return;
    const accepted = rows.filter(row => row[0] === preference.generation);
    if (!accepted.length) return;
    const now = Date.now();
    const rotate = !file || now - createdAt >= RETENTION_MS || generation !== preference.generation || count + accepted.length > MAX_FILE_ROWS;
    if (rotate) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      file = path.join(folder, "calls-" + now + "-" + randomUUID() + ".jsonl");
      createdAt = now;
      generation = preference.generation;
      count = 0;
    }
    const current = telemetryPreference(directory);
    if (!current.enabled || current.generation !== generation || !file) return;
    await fs.appendFile(file, accepted.map(row => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
    count += accepted.length;
    if (rotate) {
      const { excess } = await callFiles(folder);
      await Promise.allSettled(excess.map(name => fs.unlink(path.join(folder, name))));
    }
  }

  function flush() {
    if (writing) return writing;
    if (scheduled) { clearImmediate(scheduled); scheduled = undefined; }
    if (!queue.length) return Promise.resolve();
    const batch = queue;
    queue = [];
    writing = persist(batch).catch(() => { /* Local diagnostics never fail a tool call. */ })
      .finally(() => { writing = undefined; schedule(); });
    return writing;
  }

  function record(sample: unknown, measurement: CallMeasurement, input: unknown, result: unknown, environment?: Parameters<typeof telemetryEnvironment>[0]) {
    const preference = telemetryPreference(directory);
    if (!preference.enabled || queue.length >= MAX_QUEUE_ROWS) return;
    const event = eventSchema.safeParse({
      sample, ...telemetryEnvironment(environment), at: measurement.at, duration_ms: Math.round(measurement.elapsedMs),
      request_json_bytes: jsonBytes(input), response_json_bytes: jsonBytes(result),
      dispatch: measurement.dispatch, approval: measurement.approval, stages_ms: measurement.stagesMs,
    });
    if (!event.success) return;
    queue.push([preference.generation, event.data]);
    schedule();
  }

  return { record, flush };
}

let writer: { directory: string; store: ReturnType<typeof createLocalDiagnostics> } | undefined;
export function recordLocalDiagnostics(...args: Parameters<ReturnType<typeof createLocalDiagnostics>["record"]>) {
  const directory = telemetryDirectory();
  if (writer?.directory !== directory) writer = { directory, store: createLocalDiagnostics(directory) };
  writer.store.record(...args);
}

export async function summarizeLocalDiagnostics(directory = telemetryDirectory()) {
  const preference = telemetryPreference(directory);
  const folder = path.join(directory, "calls");
  const totals = { success: 0, failure: 0, partial: 0, timeout: 0, approval_required: 0, authorization_required: 0, unclean_exit: 0 };
  const groups = new Map<string, { dimensions: object; calls: number; first: number; last: number; durationMs: number;
    requestBytes: number; responseBytes: number; retries: number; acknowledged: number; unknown: number; stagesMs: LocalEvent["stages_ms"] }>();
  const { retained } = preference.enabled ? await callFiles(folder) : { retained: [] };
  for (const name of retained) {
    const file = path.join(folder, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(0, MAX_FILE_ROWS)) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const [generation, event] = parsed.data;
      if (generation !== preference.generation || event.at < Date.now() - RETENTION_MS) continue;
      const { tool, operation, outcome, error_code, adapter, release, failure_stage, retry_count } = event.sample;
      totals[outcome]++;
      const dimensions = { tool, operation, outcome, error_code, adapter, release, failure_stage,
        approval: event.approval, browser_family: event.browser_family, browser_major: event.browser_major };
      const key = JSON.stringify(dimensions);
      const group = groups.get(key) ?? { dimensions, calls: 0, first: event.at, last: event.at, durationMs: 0, requestBytes: 0,
        responseBytes: 0, retries: 0, acknowledged: 0, unknown: 0, stagesMs: {} };
      group.calls++;
      group.first = Math.min(group.first, event.at); group.last = Math.max(group.last, event.at);
      group.durationMs += event.duration_ms; group.requestBytes += event.request_json_bytes; group.responseBytes += event.response_json_bytes;
      group.retries += retry_count; group.acknowledged += Number(event.dispatch === "acknowledged"); group.unknown += Number(event.dispatch === "unknown");
      for (const stage of telemetryStageSchema.options) {
        const duration = event.stages_ms[stage];
        if (duration !== undefined) group.stagesMs[stage] = (group.stagesMs[stage] ?? 0) + duration;
      }
      groups.set(key, group);
    }
  }
  const errors = totals.failure + totals.partial + totals.timeout, completed = errors + totals.success;
  return {
    enabled: preference.enabled, totals, completed, failureRate: completed ? errors / completed : null,
    groups: [...groups.values()].sort((left, right) => right.calls - left.calls).map(({ first, last, ...group }) => ({
      ...group, firstSeen: new Date(first).toISOString(), lastSeen: new Date(last).toISOString(),
    })),
  };
}
