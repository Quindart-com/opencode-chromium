import { record } from "../shared/values.ts";
const SECRET_KEYS = /pass(word|code)?|otp|token|secret|authorization|cookie|clipboard|credit.?card|cvv|body|postData|prompt|fileContent/i;
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

export function redact(value: unknown, { key = "" }: { key?: string } = {}): unknown {
  if (SECRET_KEYS.test(String(key))) return "[REDACTED]";
  if (typeof value === "string") return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, { key: name })]));
  return value;
}

type LogLevel = "debug" | "info" | "warn" | "error";
export function createLogger({ name = "opencode-browser-plugin", sink = process.stderr, level = "info", clock = () => new Date().toISOString() }: { name?: string; sink?: { write(text: string): unknown }; level?: LogLevel; clock?: () => string } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;
  function write(kind: LogLevel, message: string, data: Record<string, unknown> = {}) {
    if ((levels[kind] ?? levels.info) < threshold) return;
    const line = JSON.stringify({ timestamp: clock(), level: kind, logger: name, message, ...record(redact(data)) });
    sink?.write?.(`${line}\n`);
  }
  return {
    debug: (message: string, data?: Record<string, unknown>) => write("debug", message, data),
    info: (message: string, data?: Record<string, unknown>) => write("info", message, data),
    warn: (message: string, data?: Record<string, unknown>) => write("warn", message, data),
    error: (message: string, data?: Record<string, unknown>) => write("error", message, data),
    child(childName: string) { return createLogger({ name: `${name}.${childName}`, sink, level, clock }); },
  };
}
