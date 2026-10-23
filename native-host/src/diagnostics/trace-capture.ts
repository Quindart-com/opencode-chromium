// Normalizes Tracing.dataCollected chunks (objects, JSON strings, or arrays
// of trace events) into a flat event array, and serializes the same chunks
// back into a single JSON document for artifact storage.
import { record } from "../../../src/shared/values.ts";

export function traceEventsFromChunks(chunks: unknown): unknown[] {
  if (!Array.isArray(chunks)) return [];
  const events: unknown[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("[")) {
        try {
          const parsed = (JSON.parse(trimmed) as unknown);
          if (Array.isArray(parsed)) events.push(...parsed);
          continue;
        } catch {
          // Fall through to single-object parsing.
        }
      }
      try {
        events.push((JSON.parse(trimmed) as unknown));
      } catch {
        // A malformed chunk is dropped; the rest of the trace still analyzes.
      }
      continue;
    }
    if (Array.isArray(chunk)) {
      events.push(...chunk);
      continue;
    }
    if (chunk && typeof chunk === "object") events.push(chunk);
  }
  return events;
}

export function traceEventsFromJson(json: unknown): unknown[] {
  if (typeof json !== "string") return Array.isArray(json) ? json : [];
  try {
    const parsed: unknown = (JSON.parse(json) as unknown);
    if (Array.isArray(parsed)) return parsed;
    const events = record(parsed).traceEvents;
    if (Array.isArray(events)) return events;
    return [];
  } catch {
    return [];
  }
}

export function traceChunksToJson(chunks: unknown) {
  return JSON.stringify(traceEventsFromChunks(chunks));
}
