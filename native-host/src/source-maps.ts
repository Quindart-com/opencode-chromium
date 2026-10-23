import { TraceMap,originalPositionFor } from "@jridgewell/trace-mapping";
import { z } from "zod";
import { callFrameSchema } from "../../src/browser/events.ts";
const mapSchema = z.object({ version: z.literal(3), names: z.array(z.string()), sources: z.array(z.string()), mappings: z.string(),
  file: z.string().optional(), sourceRoot: z.string().optional(), sourcesContent: z.array(z.string().nullable()).optional() });
export class SourceMapResolver {
  private readonly maps = new Map<string, TraceMap>();
  has(scriptUrl: unknown) { return this.maps.has(String(scriptUrl)); }
  set(scriptUrl: unknown, value: unknown): boolean {
    try { this.maps.set(String(scriptUrl), new TraceMap(mapSchema.parse(value))); return true; } catch { return false; }
  }
  originalPositionFor(scriptUrl: string, generatedLine: number, generatedColumn: number) {
    const map = this.maps.get(scriptUrl);
    if (!map) return null;
    try {
      const position = originalPositionFor(map, { line: generatedLine, column: generatedColumn });
      return position.source === null ? null : { source: position.source, line: position.line, column: position.column, name: position.name ?? null };
    } catch { return null; }
  }
  clear() { this.maps.clear(); }
}
export function mapCallFrames(value: unknown, resolver: SourceMapResolver | null, limit = 5) {
  const frames = z.array(callFrameSchema).safeParse(value);
  if (!frames.success) return [];
  return frames.data.slice(0, limit).map(frame => {
    const line = frame.lineNumber === undefined ? null : frame.lineNumber + 1;
    const column = frame.columnNumber === undefined ? null : frame.columnNumber + 1;
    const generated = { url: frame.url ?? null, line, column };
    const mapped = frame.url && resolver ? resolver.originalPositionFor(frame.url, (frame.lineNumber ?? 0) + 1, frame.columnNumber ?? 0) : null;
    return { function: frame.functionName || null, ...(mapped ? { url: mapped.source, line: mapped.line, column: mapped.column === null ? null : mapped.column + 1 } : generated), ...(mapped?.name ? { name: mapped.name } : {}), generated };
  });
}
