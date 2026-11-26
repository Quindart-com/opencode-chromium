import { afterEach,expect,test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelemetry } from "../../native-host/src/telemetry/index.ts";
import { setTelemetryPreference,telemetryPreference } from "../../src/telemetry/settings.ts";
import { createTelemetryCollector } from "../../src/telemetry/collector.ts";
import { measureTelemetryStage,measureTool,noteTelemetryDispatch,noteTelemetryRetry } from "../../src/core/telemetry.ts";
import { createLocalDiagnostics,summarizeLocalDiagnostics } from "../../src/telemetry/local.ts";
import type { TelemetrySample } from "../../src/shared/telemetry-schema.ts";
import { telemetryPermission } from "../../extension-src/telemetry-permission.ts";
import { zarazPayload } from "../../native-host/src/telemetry/zaraz.ts";

const roots: string[] = [], clients: ReturnType<typeof createTelemetry>[] = [];
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-test-")); roots.push(value); return value; }
const sample: TelemetrySample = { tool: "browser_run", operation: "run", outcome: "success", error_code: "NONE", duration_bucket: "lt_100ms", adapter: "mcp", release: "2.0.5", recovery: "none", replay: "none", retry_count: 0 };
function client(extra: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
  const value = createTelemetry({ directory: directory(), transport: "collector", endpoint: "https://diagnostics.example/v1/diagnostics", environment: () => ({ browserName: "Chromium", browserVersion: "142.0.1" }), allowed: async () => true, ...extra });
  clients.push(value); return value;
}
afterEach(async () => {
  for (const value of clients.splice(0)) { value.configure(false); await value.close(); }
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("diagnostics-test-")) throw new Error("Unexpected test directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics default on, persist opt-out, fail closed and honor environment controls", () => {
  const root = directory();
  expect(telemetryPreference(root).enabled).toBe(true);
  setTelemetryPreference(false, root);
  expect(telemetryPreference(root).enabled).toBe(false);
  setTelemetryPreference(true, root);
  expect(telemetryPreference(root).enabled).toBe(true);
  const previous = process.env.DO_NOT_TRACK;
  try { process.env.DO_NOT_TRACK = "1"; expect(telemetryPreference(root).enabled).toBe(false); }
  finally { if (previous === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = previous; }
  fs.writeFileSync(path.join(root, "settings.json"), "{}");
  expect(telemetryPreference(root).enabled).toBe(false);
  expect(() => setTelemetryPreference("false" as unknown as boolean, root)).toThrow();
});

test("only strict summaries are aggregated; hostile fields and browser names never leave the host", async () => {
  const payloads: string[] = [];
  const value = client({ environment: () => ({ browserName: "secret@example.test", browserVersion: "secret-path" }), fetcher: (async (_url, init) => {
    payloads.push(String(init?.body)); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); return new Response(null, { status: 204 });
  }) as typeof fetch });
  value.record(sample); value.record(sample);
  value.record({ ...sample, url: "https://private.example/secret", profileId: "private-id" });
  value.record({ ...sample, error_code: "secret@example.test" });
  await value.flush();
  expect(payloads).toHaveLength(1);
  const body = JSON.parse(payloads[0]!);
  expect(body.events).toHaveLength(1); expect(body.events[0].count).toBe(2);
  expect(body.events[0].dimensions.browser_family).toBe("unknown");
  expect(body.events[0].dimensions.browser_major).toBe(0);
  expect(payloads[0]).not.toMatch(/secret|private|profileId|example\.test/);
});

test("opt-out in a different host discards old counters even after re-enabling", async () => {
  const root = directory(); let uploads = 0;
  const value = client({ directory: root, fetcher: (async () => { uploads++; return new Response(null, { status: 204 }); }) as typeof fetch });
  value.record(sample);
  setTelemetryPreference(false, root); setTelemetryPreference(true, root);
  await value.flush(); expect(uploads).toBe(0);
  value.record(sample); await value.flush(); expect(uploads).toBe(1);
  value.configure(false); value.record(sample); await value.flush(); expect(uploads).toBe(1);
});

test("disabled, unconfigured and browser-denied diagnostics send nothing", async () => {
  let uploads = 0;
  const fetcher = (async () => { uploads++; return new Response(null, { status: 204 }); }) as typeof fetch;
  for (const options of [{ endpoint: null }, { endpoint: "http://insecure.example/v1/diagnostics" }, { endpoint: "https://user:secret@example.test/v1/diagnostics" }, { allowed: async () => false }]) {
    const value = client({ ...options, fetcher }); value.record(sample); await value.flush();
  }
  const value = client({ fetcher }); value.configure(false); value.record(sample); await value.flush();
  expect(uploads).toBe(0);
  expect(await telemetryPermission(true, async () => ({ data_collection: [] }))).toBe(false);
  expect(await telemetryPermission(true, async () => ({}))).toBe(false);
  expect(await telemetryPermission(true, async () => ({ data_collection: ["technicalAndInteraction"] }))).toBe(true);
  expect(await telemetryPermission(false, async () => { throw new Error("not called"); })).toBe(true);
});

test("opting out aborts a pending upload and reporting failures never escape", async () => {
  let aborted = false;
  const value = client({ fetcher: (async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); });
    queueMicrotask(() => value.configure(false));
  })) as typeof fetch });
  value.record(sample); await value.flush(); expect(aborted).toBe(true);
  const broken = client({ fetcher: (async () => { throw new Error("private transport error"); }) as typeof fetch });
  broken.record(sample); await expect(broken.flush()).resolves.toBeUndefined();
});

test("tool telemetry counts real retries, preserves results and excludes all input/result text", async () => {
  const reports: TelemetrySample[] = [];
  const reporter = { telemetry: (value: TelemetrySample) => { reports.push(value); } };
  const privateResult = { ok: false, status: "partial", results: [{ ok: false, error: { code: "TIMEOUT", message: "private page text" } }], secret: "secret" };
  expect(await measureTool(reporter, "browser_run", { steps: [{ value: "private typed text" }] }, { agent: "mcp" }, () => { noteTelemetryRetry(); return privateResult; })).toBe(privateResult);
  expect(reports[0]?.outcome).toBe("timeout"); expect(reports[0]?.retry_count).toBe(1);
  expect(JSON.stringify(reports)).not.toMatch(/secret|private|typed|page text/);
  const error = new Error("private exception");
  await expect(measureTool(reporter, "browser_observe", { mode: "inspect" }, {}, () => { throw error; })).rejects.toBe(error);
  expect(reports[1]?.outcome).toBe("failure");
  const unchanged = { ok: true };
  expect(await measureTool({ telemetry() { throw new Error("diagnostic failed"); } }, "browser_session", {}, {}, () => unchanged)).toBe(unchanged);
});

test("one local terminal sample retains profile and post-action errors without storing payloads", async () => {
  const dir = directory(), chromium = createLocalDiagnostics(dir), firefox = createLocalDiagnostics(dir);
  const reporter = (store: typeof chromium, browserName: string) => ({
    telemetry: (summary: TelemetrySample, result: unknown, input: unknown, _context: unknown, _profile?: string | null,
      measurement?: Parameters<typeof chromium.record>[1]) => {
      if (measurement) store.record(summary, measurement, input, result, { browserName, browserVersion: "158.3" });
    },
  });
  const confirmedThenStale = { ok: false, status: "partial", results: [{ action: "click", ok: true }],
    observation: { ok: false, error: { code: "STALE_OBSERVATION", message: "Private confirmation" } } };
  const lookupError = Object.assign(new Error("Private profile details"), { code: "NO_BROWSER_PROFILE" });
  await Promise.all([
    measureTool(reporter(chromium, "Chromium"), "browser_run", { target: "private-input" }, { agent: "mcp" }, async () => {
      await measureTelemetryStage("action", async () => { noteTelemetryDispatch("acknowledged"); });
      await measureTelemetryStage("observe", async () => { throw new Error("private DOM"); }).catch(() => {});
      return confirmedThenStale;
    }),
    measureTool(reporter(firefox, "Firefox"), "browser_observe", { mode: "read" }, { agent: "opencode" }, () =>
      measureTelemetryStage("profile", async () => { throw lookupError; })).catch(() => {}),
    measureTool(reporter(firefox, "Firefox"), "browser_run", {}, {}, () => ({ ok: false, status: "approval_required" })),
  ]);
  await Promise.all([chromium.flush(), firefox.flush()]);
  const report = await summarizeLocalDiagnostics(dir);
  expect(report.totals).toMatchObject({ partial: 1, failure: 1, approval_required: 1 });
  expect(report.completed).toBe(2);
  expect(report.groups.find(group => group.acknowledged === 1)).toMatchObject({
    calls: 1, dimensions: { error_code: "STALE_OBSERVATION", failure_stage: "observe", browser_family: "chromium" },
    responseBytes: Buffer.byteLength(JSON.stringify(confirmedThenStale)),
  });
  expect(report.groups.find(group => (group.dimensions as { error_code?: string }).error_code === "NO_BROWSER_PROFILE")).toMatchObject({
    calls: 1, dimensions: { failure_stage: "profile", browser_family: "firefox" },
  });
  const folder = path.join(dir, "calls");
  expect(fs.readdirSync(folder)).toHaveLength(2);
  for (const name of fs.readdirSync(folder)) expect(fs.readFileSync(path.join(folder, name), "utf8")).not.toMatch(/private/i);
});

test("local diagnostics respect preference changes and remain best-effort on a busy or unwritable writer", async () => {
  const dir = directory(), log = createLocalDiagnostics(dir);
  const measurement = { at: Date.now(), elapsedMs: 1, stagesMs: {} };
  log.record(sample, measurement, {}, {});
  setTelemetryPreference(false, dir);
  await log.flush();
  expect((await summarizeLocalDiagnostics(dir)).completed).toBe(0);
  setTelemetryPreference(true, dir);
  for (let index = 0; index < 170; index++) log.record(sample, measurement, {}, {});
  await log.flush();
  expect((await summarizeLocalDiagnostics(dir)).completed).toBe(128);
  setTelemetryPreference(false, dir);
  setTelemetryPreference(true, dir);
  expect((await summarizeLocalDiagnostics(dir)).completed).toBe(0);

  const brokenDir = directory(), broken = createLocalDiagnostics(brokenDir);
  fs.writeFileSync(path.join(brokenDir, "calls"), "unwritable-directory-fixture");
  broken.record(sample, measurement, {}, {});
  await expect(broken.flush()).resolves.toBeUndefined();
  expect((await summarizeLocalDiagnostics(brokenDir)).completed).toBe(0);
});

test("collector strips network identity, rotates batch IDs and keeps GA credentials server-side", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fixtureSecret = randomUUID();
  const handle = createTelemetryCollector({ measurementId: "G-SYNTHETIC", apiSecret: fixtureSecret, fetcher: (async (url, init) => {
    calls.push({ url: String(url), init: init! }); return new Response(null, { status: 204 });
  }) as typeof fetch });
  const dimensions = { ...sample, browser_family: "chromium", browser_major: 142, os_family: "windows" };
  const body = JSON.stringify({ schema_version: 1, events: [{ dimensions, count: 7 }] });
  for (let i = 0; i < 2; i++) expect((await handle(new Request("https://collector.example/v1/diagnostics", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", "User-Agent": "private-user-agent", Cookie: "private-cookie" }, body }))).status).toBe(204);
  const first = JSON.parse(String(calls[0]!.init.body)), second = JSON.parse(String(calls[1]!.init.body));
  expect(first.client_id).not.toBe(second.client_id);
  expect(first.events[0].params.occurrences).toBe(7);
  expect(first.consent).toEqual({ ad_user_data: "DENIED", ad_personalization: "DENIED" });
  expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
  for (const { url, init } of calls) {
    const endpoint = new URL(url);
    expect(endpoint.origin + endpoint.pathname).toBe("https://region1.google-analytics.com/mp/collect");
    expect(endpoint.searchParams.get("api_secret")).toBe(fixtureSecret);
    expect(String(init.body)).not.toMatch(/private|203\.0\.113/);
    expect(String(init.body)).not.toContain(fixtureSecret);
  }
  const rejected = await handle(new Request("https://collector.example/v1/diagnostics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema_version: 1, events: [{ dimensions: { ...dimensions, url: "private" }, count: 1 }] }) }));
  expect(rejected.status).toBe(400); expect(calls).toHaveLength(2);
});

test("dead host markers report an unclean exit once; normal shutdown clears its marker", async () => {
  const root = directory(), markerDir = path.join(root, "running");
  fs.mkdirSync(markerDir);
  fs.writeFileSync(path.join(markerDir, "2147483647-dead-beef.json"), JSON.stringify({ generation: "initial", release: "2.0.4" }));
  const payloads: string[] = [];
  const value = client({ directory: root, fetcher: (async (_url, init) => { payloads.push(String(init?.body)); return new Response(null, { status: 204 }); }) as typeof fetch });
  await value.start("2.0.5"); await value.start("2.0.5"); await value.flush();
  expect(JSON.parse(payloads[0]!).events[0].dimensions.outcome).toBe("unclean_exit");
  expect(payloads[0]).not.toMatch(/2147483647|generation|dead-beef/);
  expect(fs.readdirSync(markerDir)).toHaveLength(1);
  await value.close(); expect(fs.readdirSync(markerDir)).toHaveLength(0);
});

test("Zaraz receives bounded counters with transient IDs and no browsing context or returned script execution", async () => {
  const batch = { schema_version: 1, events: [{ dimensions: { ...sample, browser_family: "chromium", browser_major: 142, os_family: "windows" }, count: 4 }] };
  const first = zarazPayload(batch, "https://collector.example.test/diagnostics");
  const second = zarazPayload(batch, "https://collector.example.test/diagnostics");
  expect(first.events[0]?.client.cid).not.toBe(second.events[0]?.client.cid);
  expect(first.events[0]?.client.__zarazTrack).toBe("opencode_tool_outcome");
  expect(first.events[0]?.client.occurrences).toBe(4);
  expect(first.events[0]?.system.cookies).toEqual({});
  expect(first.events[0]?.system.page.url).toBe("https://collector.example.test/");
  let uploaded: any;
  const value = client({ transport: "zaraz", fetcher: (async (_url, init) => {
    uploaded = JSON.parse(String(init?.body));
    expect(init?.headers).toEqual({ "Content-Type": "application/json", "User-Agent": "OpenCodeBrowserDiagnostics/1" });
    return Response.json({ results: [{ execute: "throw new Error('must never execute')", cookies: { private: "not-stored" } }] });
  }) as typeof fetch });
  value.record(sample); await value.flush();
  expect(uploaded.events[0].client.occurrences).toBe(1);
  expect(() => zarazPayload({ ...batch, private: "rejected" }, "https://collector.example.test/")).toThrow();
});
