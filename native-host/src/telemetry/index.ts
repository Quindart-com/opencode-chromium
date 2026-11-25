import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { telemetryBatchSchema,telemetryEnvironment,telemetrySampleSchema,type TelemetryDimensions,type TelemetrySample } from "../../../src/shared/telemetry-schema.ts";
import { record } from "../../../src/shared/values.ts";
import { setTelemetryPreference,telemetryDirectory,telemetryPreference } from "../../../src/telemetry/settings.ts";
import { zarazPayload } from "./zaraz.ts";

type Options = {
  directory?: string; endpoint?: string | null; fetcher?: typeof fetch;
  transport?: "collector" | "zaraz";
  environment(): { browserName?: string | null; browserVersion?: string | null } | null;
  allowed(): Promise<boolean>;
};
function deliveryConfig() {
  try {
    const packageJson: unknown = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const config = record(record(packageJson).telemetry);
    return { endpoint: process.env.OPENCODE_BROWSER_TELEMETRY_URL ?? config.collectorUrl, transport: config.transport === "zaraz" ? "zaraz" : "collector" } as const;
  } catch { return { endpoint: process.env.OPENCODE_BROWSER_TELEMETRY_URL, transport: "collector" } as const; }
}
function safeEndpoint(value: unknown) {
  try { const url = new URL(String(value)); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.href : null; } catch { return null; }
}

/** Per-host memory-only counters. Nothing identifies a user, profile, page, or installation. */
export function createTelemetry(options: Options) {
  const directory = options.directory ?? telemetryDirectory();
  const config = deliveryConfig();
  const endpoint = safeEndpoint(options.endpoint === undefined ? config.endpoint : options.endpoint);
  const transport = options.transport ?? config.transport;
  const fetcher = options.fetcher ?? fetch;
  const counters = new Map<string, { dimensions: TelemetryDimensions; count: number }>();
  let generation = "", timer: ReturnType<typeof setInterval> | undefined, sending: Promise<void> | undefined;
  let controller: AbortController | undefined, marker: string | undefined, closed = false, starting = false;
  const preference = () => telemetryPreference(directory);
  function synchronize() {
    const current = preference();
    if (!current.enabled || generation !== current.generation) { counters.clear(); controller?.abort(); }
    generation = current.generation;
    return current.enabled;
  }
  function recordSample(input: unknown, previousEnvironment?: { browserName?: string | null; browserVersion?: string | null }) {
    if (closed || !endpoint || !synchronize()) return;
    const sample = telemetrySampleSchema.safeParse(input);
    if (!sample.success) return;
    const environment = previousEnvironment ?? options.environment();
    if (!environment) return;
    const dimensions: TelemetryDimensions = { ...sample.data, ...telemetryEnvironment(environment),
      os_family: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other" };
    const key = JSON.stringify(dimensions), previous = counters.get(key);
    if (previous) previous.count = Math.min(1000000, previous.count + 1);
    else if (counters.size < 250) counters.set(key, { dimensions, count: 1 });
    timer ??= setInterval(() => { void flush(); }, 300000);
    timer.unref();
  }
  async function deliver() {
    if (!endpoint || !synchronize() || !counters.size) return;
    let allowed = false;
    try { allowed = await options.allowed(); } catch { /* Missing consent fails closed. */ }
    if (!allowed || !synchronize()) { counters.clear(); return; }
    const sentGeneration = generation;
    const entries = [...counters.entries()].slice(0, 25);
    const body = telemetryBatchSchema.parse({ schema_version: 1, events: entries.map(([, value]) => value) });
    for (const [key] of entries) counters.delete(key);
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 1500);
    const watch = setInterval(() => { synchronize(); }, 250);
    timeout.unref(); watch.unref();
    try {
      const payload = transport === "zaraz" ? zarazPayload(body, endpoint) : body;
      const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "OpenCodeBrowserDiagnostics/1" }, body: JSON.stringify(payload),
        signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      await response.body?.cancel();
      // Diagnostic delivery is lossy: never duplicate batches or grow a retry backlog.
    } catch { /* Offline or blocked diagnostics never interfere with browser work. */ }
    finally {
      clearTimeout(timeout); clearInterval(watch); controller = undefined;
      if (preference().generation !== sentGeneration) counters.clear();
    }
  }
  function flush() {
    if (!sending) sending = deliver().catch(() => {}).finally(() => { sending = undefined; });
    return sending;
  }
  async function start(release: string) {
    if (marker || starting || closed || !endpoint || !synchronize()) return;
    starting = true;
    try {
      if (!await options.allowed().catch(() => false) || closed || !synchronize()) return;
      const markers = path.join(directory, "running");
      fs.mkdirSync(markers, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(markers).slice(0, 200)) {
        if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
        const file = path.join(markers, name);
        let value: unknown;
        try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
        const data = record(value);
        const pid = Number(name.split("-")[0]);
        try { process.kill(pid, 0); continue; } catch (error) { if (record(error).code !== "ESRCH") continue; }
        // Atomic claim prevents two starting profiles from counting the same exit.
        const claimed = `${file}.claimed-${process.pid}`;
        try { fs.renameSync(file, claimed); } catch { continue; }
        fs.unlinkSync(claimed);
        if (data.generation !== generation) continue;
        recordSample({ tool: "runtime", operation: "unclean_exit", outcome: "unclean_exit", error_code: "OTHER", duration_bucket: "lt_100ms", adapter: "unknown",
          release: typeof data.release === "string" ? data.release : release, recovery: "none", replay: "none", retry_count: 0 },
          { browserName: ["chromium", "firefox", "edge", "opera"].includes(String(data.browserFamily)) ? String(data.browserFamily) : "unknown",
            browserVersion: Number.isInteger(data.browserMajor) && Number(data.browserMajor) >= 0 && Number(data.browserMajor) <= 9999 ? String(data.browserMajor) : "0" });
      }
      marker = path.join(markers, `${process.pid}-${randomUUID()}.json`);
      const environment = options.environment();
      const { browser_family, browser_major } = telemetryEnvironment(environment);
      fs.writeFileSync(marker, JSON.stringify({ release, generation, browserFamily: browser_family, browserMajor: browser_major }), { mode: 0o600 });
    } catch { /* Runtime health reporting is optional. */ }
    finally { starting = false; }
  }
  function status() {
    synchronize();
    return { enabled: preference().enabled, configured: !!endpoint, environmentDisabled: process.env.OPENCODE_BROWSER_TELEMETRY === "0" || process.env.DO_NOT_TRACK === "1" };
  }
  function configure(enabled: boolean) {
    setTelemetryPreference(enabled, directory); synchronize();
    return status();
  }
  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    if (marker) { try { fs.unlinkSync(marker); } catch { /* Already removed. */ } marker = undefined; }
    await flush(); counters.clear();
  }
  return { record: recordSample, flush, start, close, status, configure,
    handle(method: string, params: Record<string, unknown> = {}) {
      if (method === "telemetry.status") return status();
      if (method === "telemetry.configure") return configure(params.enabled as boolean);
      if (method === "telemetry.record") { recordSample(params); return { ok: true }; }
      return undefined;
    },
  };
}
export type { TelemetrySample };
