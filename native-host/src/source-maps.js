import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

// Source-map resolution is a native-host concern: it is CPU-light relative to
// embedding or parsing, cached per script URL, and never sends page content
// anywhere. Map fetching itself stays inside the browser/CDP context so
// cookie and authorization context is preserved.
export class SourceMapResolver {
  constructor() {
    this.maps = new Map();
  }

  has(scriptUrl) {
    return this.maps.has(String(scriptUrl));
  }

  set(scriptUrl, mapJson) {
    if (!mapJson || typeof mapJson !== "object") return false;
    try {
      this.maps.set(String(scriptUrl), new TraceMap(mapJson));
      return true;
    } catch {
      return false;
    }
  }

  originalPositionFor(scriptUrl, generatedLine, generatedColumn) {
    const map = this.maps.get(String(scriptUrl));
    if (!map) return null;
    try {
      const position = originalPositionFor(map, { line: generatedLine, column: generatedColumn });
      if (!position || position.source == null) return null;
      return {
        source: position.source,
        line: Number.isInteger(position.line) ? position.line : null,
        column: Number.isInteger(position.column) ? position.column : null,
        name: position.name ?? null,
      };
    } catch {
      return null;
    }
  }

  clear() {
    this.maps.clear();
  }
}

export function mapCallFrames(callFrames, resolver, limit = 5) {
  const frames = Array.isArray(callFrames) ? callFrames : [];
  return frames.slice(0, limit).map((frame) => {
    const line = Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null;
    const column = Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null;
    const generated = { url: frame.url ?? null, line, column };
    const mapped = resolver && frame.url
      ? resolver.originalPositionFor(frame.url, (frame.lineNumber ?? 0) + 1, frame.columnNumber ?? 0)
      : null;
    return {
      function: frame.functionName || null,
      ...(mapped && mapped.source
        ? { url: mapped.source, line: mapped.line, column: mapped.column !== null ? mapped.column + 1 : null }
        : generated),
      ...(mapped?.name ? { name: mapped.name } : {}),
      generated,
    };
  });
}