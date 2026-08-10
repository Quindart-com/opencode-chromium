// Normalizes Tracing.dataCollected chunks (objects, JSON strings, or arrays
// of trace events) into a flat event array, and serializes the same chunks
// back into a single JSON document for artifact storage.
export function traceEventsFromChunks(chunks) {
  if (!Array.isArray(chunks)) return [];
  const events = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) events.push(...parsed);
          continue;
        } catch {
          // Fall through to single-object parsing.
        }
      }
      try {
        events.push(JSON.parse(trimmed));
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

export function traceEventsFromJson(json) {
  if (typeof json !== "string") return Array.isArray(json) ? json : [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.traceEvents)) return parsed.traceEvents;
    return [];
  } catch {
    return [];
  }
}

export function traceChunksToJson(chunks) {
  return JSON.stringify(traceEventsFromChunks(chunks));
}