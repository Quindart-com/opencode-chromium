import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { configureProvider, providerModel } from "../../native-host/src/decisions/settings.ts";
import { decisionSearch } from "../../native-host/src/decisions/search.ts";
import { decide } from "../../native-host/src/decisions/index.ts";
import { decisionBudget } from "../../native-host/src/decisions/budget.ts";
import { reserveImageRequest, imageRequestAvailable } from "../../native-host/src/decisions/image-budget.ts";

const originalDirectory = process.env.AGENT_BROWSER_PROVIDER_DIR;
const originalKey = process.env.TEST_JEV_IMAGE_KEY;
const originalFetch = globalThis.fetch;
let directory: string, allow: ReturnType<typeof spyOn>, calls: any[], captures: number, query: string;
const image = `data:image/png;base64,${PNG.sync.write(new PNG({ width: 320, height: 280 })).toString("base64")}`;
const units = [{ node_id: "a", name: "Apply", role: "button", score: 0.5, boundingBox: { x: 0, y: 0, width: 300, height: 200 } },
  { node_id: "b", name: "Apply", role: "button", score: 0.5, boundingBox: { x: 500, y: 0, width: 300, height: 200 } }];
const settings = { provider: "jev" as const, route: "openrouter" as const, shareText: true, shareImages: true, keyEnv: "TEST_JEV_IMAGE_KEY" };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-image-fallback-"));
  process.env.AGENT_BROWSER_PROVIDER_DIR = directory; process.env.TEST_JEV_IMAGE_KEY = randomUUID();
  configureProvider(settings); calls = []; captures = 0; query = `green control ${randomUUID()}`;
  allow = spyOn(decisionBudget, "allow").mockReturnValue(true);
});
afterEach(() => {
  allow.mockRestore(); globalThis.fetch = originalFetch;
  if (originalDirectory === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR; else process.env.AGENT_BROWSER_PROVIDER_DIR = originalDirectory;
  if (originalKey === undefined) delete process.env.TEST_JEV_IMAGE_KEY; else process.env.TEST_JEV_IMAGE_KEY = originalKey;
  fs.rmSync(directory, { recursive: true, force: true });
});
function network(textConfidence = 0.4, httpStatus = 200) {
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const visual = Array.isArray(body.input ?? body.state), confidence = visual ? 0.95 : textConfidence;
    if (httpStatus !== 200) return new Response("unavailable", { status: httpStatus });
    if (body.input !== undefined) return Response.json({ model: body.model, answers: [{ type: "choice", name: "decision", choice: "b", confidence,
      probabilities: [{ value: "a", probability: 0.02 }, { value: "b", probability: 0.95 }, { value: "__abstain", probability: 0.03 }] }], usage: { input_tokens: visual ? 500 : 100, output_tokens: 0 } });
    return new Response(JSON.stringify({ model: body.model, answers: { decision: { type: "choice", choice: "b", confidence,
      probabilities: { a: 0.02, b: 0.95, __abstain: 0.03 } } }, usage: { input_tokens: visual ? 500 : 100, output_tokens: 0 } }));
  }) as typeof fetch;
}
const search = (capture = async () => { captures++; return image; }) => decisionSearch({ query, units,
  decisionState: JSON.stringify([1, "https://fixture.test/", 1000, 800, 0, 0, 1]), pageFingerprint: query, tabId: 7 }, async () => ({ results: units }), capture);

for (const route of ["openai", "openrouter"] as const) {
  test(`Luna via ${route} caches confident text without capturing or sending screenshots`, async () => {
    configureProvider({ ...settings, provider: "openai-decisions", route });
    network(0.95);
    expect((await search())?.decision).toMatchObject({ status: "selected", candidateId: "b" });
    expect((await search())?.decision).toMatchObject({ status: "selected", origin: "cache" });
    expect(calls.length).toBe(1); expect(captures).toBe(0);
    expect(typeof (calls[0].input ?? calls[0].state)).toBe("string");
  });

  test(`Luna via ${route} escalates only uncertain text and validates fresh pixels before image-cache reuse`, async () => {
    configureProvider({ ...settings, provider: "openai-decisions", route });
    network(); await search(); await search();
    expect(calls.length).toBe(2); expect(captures).toBe(2);
    expect(typeof (calls[0].input ?? calls[0].state)).toBe("string");
    expect(Array.isArray(calls[1].input ?? calls[1].state)).toBe(true);
    const changed = new PNG({ width: 320, height: 280 }); changed.data.fill(255);
    const result = await search(async () => { captures++; return `data:image/png;base64,${PNG.sync.write(changed).toString("base64")}`; });
    expect(calls.length).toBe(2); expect(result?.decision).toMatchObject({ status: "abstained", reason: "image_budget_exhausted" });
  });

  test(`Luna via ${route} never captures on provider errors or when the image quota is exhausted`, async () => {
    configureProvider({ ...settings, provider: "openai-decisions", route });
    for (const status of [401, 402, 429, 500]) { query = randomUUID(); network(0.4, status); await search(); }
    expect(calls.length).toBe(4); expect(captures).toBe(0);
    reserveImageRequest(); query = randomUUID(); network();
    expect((await search())?.decision).toMatchObject({ reason: "image_budget_exhausted" });
    expect(captures).toBe(0);
  });
}

test("Jev asks text first, then one image only on a valid unsure answer", async () => {
  network(); const result = await search();
  expect(calls.map(body => body.model)).toEqual(["typesafe/jev-1.13-20260917", "typesafe/jev-1.14"]);
  expect(typeof calls[0].state).toBe("string"); expect(calls[1].state[1].image_url.url).toBe(image);
  expect(calls[1].questions.decision.criteria.b).toContain("bounds1000(500,0,300,250)");
  expect(captures).toBe(1); expect(result?.decision).toMatchObject({ status: "selected", candidateId: "b" });
});
test("confident text results are cached and never capture", async () => {
  network(0.95); await search(); await search();
  expect(calls.length).toBe(1); expect(captures).toBe(0);
});
test("a cached image decision is reused only after matching fresh pixels, without another paid call", async () => {
  network(); await search(); await search();
  expect(calls.length).toBe(2); expect(captures).toBe(2);
  const changed = new PNG({ width: 320, height: 280 }); changed.data.fill(255);
  const otherImage = `data:image/png;base64,${PNG.sync.write(changed).toString("base64")}`;
  const result = await search(async () => { captures++; return otherImage; });
  expect(calls.length).toBe(2); expect(result?.decision).toMatchObject({ status: "abstained" });
});
test("errors never trigger image escalation", async () => {
  for (const status of [401, 402, 429, 500]) {
    process.env.TEST_JEV_IMAGE_KEY = randomUUID(); query = randomUUID(); network(0.4, status);
    const previous = calls.length; await search(); expect(calls.length - previous).toBe(1);
  }
  expect(captures).toBe(0);
});
test("revoking consent during capture discards the image without sending it", async () => {
  network(); const result = await search(async () => { captures++; configureProvider({ ...settings, shareImages: false }); return image; });
  expect(calls.length).toBe(1); expect(result?.decision).toMatchObject({ reason: "settings_changed" });
});
test("replacing a credential prevents a queued request from using the old key", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = new Promise<void>(resolve => { started = resolve; });
  network(0.95);
  const immediate = globalThis.fetch;
  globalThis.fetch = (async (...args) => {
    const response = immediate(...args);
    if (calls.length === 2) started();
    await gate;
    return response;
  }) as typeof fetch;
  const input = { purpose: "rank" as const, context: "Find a control", instructions: "Choose a known ID",
    candidates: [{ id: "a", description: "Apply left" }, { id: "b", description: "Apply right" }] };
  const pending = [decide(input), decide(input), decide(input)];
  await busy;
  process.env.TEST_JEV_IMAGE_KEY = randomUUID();
  release();
  const results = await Promise.all(pending);
  expect(calls.length).toBe(2);
  expect(results[2]).toMatchObject({ status: "abstained", reason: "settings_changed" });
});
test("exact matches, disabled image sharing and failed capture keep the local/text flow", async () => {
  network(); query = "Apply"; units[1]!.name = "Other";
  try { await search(); expect(calls.length).toBe(0); expect(captures).toBe(0); } finally { units[1]!.name = "Apply"; }
  query = randomUUID(); configureProvider({ ...settings, shareImages: false }); await search();
  expect(calls.length).toBe(1); expect(captures).toBe(0);
  configureProvider(settings); query = randomUUID(); await search(async () => { throw Error("capture failed"); });
  expect(calls.length).toBe(2);
});
test("capture cannot extend the total decision deadline", async () => {
  network(); const start = performance.now();
  const result = await search(() => new Promise(() => {}));
  expect(performance.now() - start).toBeLessThan(1900);
  expect(result?.decision).toMatchObject({ reason: "timeout" }); expect(calls.length).toBe(1);
});
test("missing or malformed viewport state preserves text fallback without capture", async () => {
  network();
  for (const decisionState of [undefined, "null", "{}", "broken", '[0,0,{"toString":1},800]']) {
    query = randomUUID();
    const result = await decisionSearch({ query, units, decisionState }, async () => ({ results: units }), async () => { captures++; return image; });
    expect(result?.decision).toMatchObject({ status: "abstained", reason: "insufficient_confidence" });
  }
  expect(captures).toBe(0); expect(calls.length).toBe(5);
});
test("image quotas survive process-local cache resets and stop capture at the minute cap", async () => {
  network(); await search(); query = randomUUID(); const limited = await search();
  expect(captures).toBe(1); expect(calls.length).toBe(3);
  expect(limited?.decision).toMatchObject({ reason: "image_budget_exhausted" });
  expect(imageRequestAvailable()).toBe(false);
});
test("atomic image reservations cap all profiles at 20 per UTC day and one per UTC minute", () => {
  const start = Date.UTC(2026, 9, 22, 2);
  expect(reserveImageRequest(start)).toBe(true); expect(reserveImageRequest(start + 100)).toBe(false);
  for (let slot = 1; slot < 20; slot++) expect(reserveImageRequest(start + slot * 60_000)).toBe(true);
  expect(reserveImageRequest(start + 21 * 60_000)).toBe(false);
  expect(reserveImageRequest(start + 86_400_000)).toBe(true);
  expect(providerModel(settings)).toBe("typesafe/jev-1.13-20260917"); expect(providerModel(settings, true)).toBe("typesafe/jev-1.14");
});
test("independent native-host processes cannot both reserve the same minute", async () => {
  const run = promisify(execFile);
  const module = new URL("../../native-host/src/decisions/image-budget.ts", import.meta.url).href;
  const code = `import { reserveImageRequest } from ${JSON.stringify(module)}; console.log(reserveImageRequest(${Date.UTC(2026, 9, 22, 4)}));`;
  const results = await Promise.all([run(process.execPath, ["-e", code], { env: process.env, windowsHide: true }), run(process.execPath, ["-e", code], { env: process.env, windowsHide: true })]);
  expect(results.map(result => result.stdout.trim()).sort()).toEqual(["false", "true"]);
});
