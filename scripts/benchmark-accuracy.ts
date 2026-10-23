import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rankPageUnits } from "../native-host/src/semantic-search.ts";
import { decisionSearch, decisionSearchStats } from "../native-host/src/decisions/search.js";
import { decisionUsage } from "../native-host/src/decisions/usage.js";
import { configureProvider, getProviderSettings, providerKey, providerModel, providerStatus, storeProviderKey } from "../native-host/src/decisions/settings.js";

// Component target accuracy, not autonomous task success. Cloud is explicitly
// opt-in: 12 fixed queries, fresh process per arm, <=6 requests per paid arm.
// No retries, model downloads, browser downloads, or user settings writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const cloud = args.includes("--cloud");
const arms = ["lexical", "jev-text", "luna-text", "luna-image"];
const fixtureFile = path.join(root, "scripts/fixtures/accuracy-settings.json");
const htmlFile = path.join(root, "scripts/fixtures/accuracy-settings.html");
const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixtureHash = hash(Buffer.concat([fs.readFileSync(fixtureFile), fs.readFileSync(htmlFile)]));
const rounded = (number: number) => Math.round(number * 1000) / 1000;
const dollars = (number: number) => Number(number.toFixed(8));
const percentile = (numbers: number[], p: number) => numbers.length ? rounded([...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * p) - 1]!) : null;
const ids = new Set(fixture.units.map((unit: any) => unit.node_id));
if (ids.size !== 30 || fixture.tasks.length !== 12 || fixture.tasks.filter((task: any) => task.bucket === "paraphrase").length !== 6 ||
  fixture.tasks.some((task: any) => !task.accepted.length || task.accepted.some((id: string) => !ids.has(id)))) throw new Error("Invalid fixed fixture");

async function measureArm(arm: string, visual: any) {
  const paid = arm !== "lexical";
  if (paid && (!cloud || process.env.OPENCODE_BENCHMARK_CHILD !== "1" || !providerStatus().ready)) throw new Error("Cloud worker is not enabled");
  const units = fixture.units.map((unit: any) => visual?.boxes?.[unit.node_id] ? { ...unit, boundingBox: visual.boxes[unit.node_id] } : unit);
  const before = decisionUsage();
  const samples = [];
  for (const task of fixture.tasks) {
    let pool: string[] = [];
    const local = async (input: any) => {
      const result = await rankPageUnits(input);
      pool = result.results.slice(0, 16).map((unit: any) => unit.node_id);
      return result;
    };
    const started = performance.now();
    const capped = paid && decisionSearchStats().called >= 6;
    const input = { query: task.query, units, maxResults: 5, mode: "lexical", pageFingerprint: fixtureHash };
    const result: any = paid && !capped
      ? await decisionSearch(input, local, visual ? async () => visual.image : undefined)
      : { ...await local({ ...input, maxResults: 16 }), ...(capped ? { decision: { status: "skipped", reason: "benchmark_call_cap" } } : {}) };
    const wallMs = rounded(performance.now() - started);
    const top = result.results[0]?.node_id ?? null;
    const returned = result.results.slice(0, 5).map((unit: any) => unit.node_id);
    const decision = result.decision ?? null;
    samples.push({ taskId: task.id, bucket: task.bucket, query: task.query, accepted: task.accepted, top,
      correct: task.accepted.includes(top), recall5: task.accepted.some((id: string) => returned.includes(id)),
      poolExpectedIncluded: task.accepted.some((id: string) => pool.includes(id)), candidatePoolIds: pool,
      wallMs, decision, fallback: paid && task.bucket === "paraphrase" && decision?.status !== "selected" });
  }
  const after = decisionUsage();
  const stats = decisionSearchStats();
  const paidCalls = stats.called;
  const delta = (name: string) => (after as any)[name] - (before as any)[name];
  const costReportedCalls = delta("costReportedCalls");
  const usageReportedCalls = delta("usageReportedCalls");
  const bucket = (name?: string) => {
    const rows = samples.filter(row => !name || row.bucket === name);
    return { tasks: rows.length, correct: rows.filter(row => row.correct).length, recall5: rows.filter(row => row.recall5).length,
      recall16: rows.filter(row => row.poolExpectedIncluded).length };
  };
  const ambiguous = samples.filter(row => row.bucket === "paraphrase");
  return { arm, requestedModel: paid ? providerModel(getProviderSettings()) : null,
    accuracy: { total: bucket(), exact: bucket("exact"), paraphrase: bucket("paraphrase") },
    latency: { p50Ms: percentile(samples.map(row => row.wallMs), .5), p95Ms: percentile(samples.map(row => row.wallMs), .95),
      paraphraseP50Ms: percentile(ambiguous.map(row => row.wallMs), .5), paraphraseP95Ms: percentile(ambiguous.map(row => row.wallMs), .95),
      totalMs: rounded(samples.reduce((sum, row) => sum + row.wallMs, 0)) },
    decisions: { paidCalls, recordedCalls: delta("calls"), selected: samples.filter(row => row.decision?.status === "selected").length,
      abstained: samples.filter(row => row.decision?.status === "abstained").length,
      unavailable: samples.filter(row => row.decision?.status === "unavailable").length,
      skippedExact: samples.filter(row => row.decision?.reason === "unique_exact_match").length,
      cacheHits: stats.cacheHits, budgetSkipped: stats.budgetSkipped, benchmarkCapSkipped: samples.filter(row => row.decision?.reason === "benchmark_call_cap").length,
      fallback: samples.filter(row => row.fallback).length },
    usage: { usageReportedCalls, costReportedCalls, reportedInputTokens: delta("inputTokens"), reportedOutputTokens: delta("outputTokens"),
      inputTokens: usageReportedCalls === paidCalls ? delta("inputTokens") : null,
      outputTokens: usageReportedCalls === paidCalls ? delta("outputTokens") : null,
      reportedCostUsd: dollars(delta("reportedCost")), costUsd: costReportedCalls === paidCalls ? dollars(delta("reportedCost")) : null }, samples };
}

async function screenshotFixture() {
  // Playwright capture runs in Node; the decision workers use Bun's TS loader.
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(process.env.BENCHMARK_NODE_BIN ?? "node", [path.join(root, "scripts/fixtures/capture-accuracy-image.mjs")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 45000,
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("Fixture screenshot process could not start")));
    child.on("close", code => {
      if (code !== 0) return reject(new Error("Installed browser fixture screenshot failed"));
      try {
        const captured = JSON.parse(output);
        resolve({ ...captured, bytes: Buffer.from(captured.image.split(",")[1], "base64") });
      } catch { reject(new Error("Invalid fixture screenshot")); }
    });
  });
}

async function worker(arm: string, providerDir: string, visual?: any) {
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--worker", arm, ...(cloud ? ["--cloud"] : [])], {
      cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_BROWSER_PROVIDER_DIR: providerDir, OPENCODE_BENCHMARK_CHILD: "1", AGENT_BROWSER_DISABLE_SEMANTIC_MODEL: "1" },
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", () => {}); // Do not publish process diagnostics or local paths.
    child.on("error", () => reject(new Error("Benchmark worker could not start")));
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Benchmark worker failed for ${arm}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Benchmark worker returned invalid results")); }
    });
    child.stdin.end(JSON.stringify(visual ? { image: visual.image, boxes: visual.boxes } : {}));
  });
}

function chart(report: any) {
  const escape = (text: any) => String(text).replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  const height = 175 + report.arms.length * 70;
  const rows = report.arms.map((arm: any, index: number) => {
    const y = 116 + index * 70;
    const count = arm.accuracy.total.correct;
    return `<text x="30" y="${y + 14}" class="label">${escape(arm.arm)}</text><rect x="170" y="${y}" width="300" height="22" rx="3" fill="#e2e8ef"/><rect x="170" y="${y}" width="${300 * count / 12}" height="22" rx="3" fill="#17644c"/><text x="485" y="${y + 16}" class="label">${count}/12</text><text x="570" y="${y + 16}" class="label">${arm.latency.paraphraseP50Ms} ms</text><text x="170" y="${y + 42}" class="note">${arm.decisions.paidCalls} requests · ${arm.decisions.fallback} fallbacks · cost ${arm.usage.costUsd === null ? "unknown" : "$" + arm.usage.costUsd}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="${height}" viewBox="0 0 850 ${height}" role="img" aria-labelledby="title description"><title id="title">Component target accuracy on 12 synthetic queries</title><desc id="description">${escape(report.scope)} One round; paraphrase latency is the median of six queries. Timeouts retain local ranking.</desc><style>text{font-family:system-ui,sans-serif;fill:#17243a}.label{font-size:14px}.note{font-size:12px;fill:#56647a}</style><rect width="850" height="${height}" fill="#ffffff"/><text x="30" y="35" font-size="21" font-weight="600">Target selection on a synthetic settings page</text><text x="30" y="59" class="note">v${report.packageVersion} · 12 unique queries · one round · 1.5 s decision deadline · no agent planning</text><text x="170" y="94" class="label">Correct target (6 exact + 6 paraphrased)</text><text x="570" y="94" class="label">Paraphrase selection p50</text>${rows}<text x="30" y="${height - 18}" class="note">Small component fixture, not WebVoyager or full task success. Missing reported cost remains unknown.</text></svg>\n`;
}

async function main() {
  const arm = value("--worker");
  if (arm) {
    if (!arms.includes(arm) || process.env.OPENCODE_BENCHMARK_CHILD !== "1") throw new Error("Worker entry point is private to this benchmark");
    const input = await new Response(process.stdin).text();
    process.stdout.write(JSON.stringify(await measureArm(arm, arm === "luna-image" ? JSON.parse(input) : undefined)));
    return;
  }
  if (args.some(arg => arg.startsWith("--") && !["--cloud", "--fixture-image", "--out"].includes(arg))) throw new Error("Supported flags: --cloud, --fixture-image, --out PATH");
  const output = path.resolve(root, value("--out") ?? "reports/benchmark-accuracy.json");
  if (!output.endsWith(".json")) throw new Error("Report output must end in .json");
  let key: string | undefined;
  if (cloud) {
    const current = getProviderSettings();
    if (current.route !== "openrouter") throw new Error("Cloud comparison requires an existing OpenRouter credential");
    key = providerKey(current);
    if (!key) throw new Error("No existing OpenRouter credential is configured");
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-accuracy-"));
  const previousProviderDir = process.env.AGENT_BROWSER_PROVIDER_DIR;
  try {
    const visual = cloud || args.includes("--fixture-image") ? await screenshotFixture() : undefined;
    const measured = [];
    for (const name of cloud ? arms : ["lexical"]) {
      const providerDir = path.join(temporary, name);
      process.env.AGENT_BROWSER_PROVIDER_DIR = providerDir;
      configureProvider({ provider: name === "lexical" ? "off" : name === "jev-text" ? "jev" : "openai-decisions",
        route: "openrouter", shareText: name !== "lexical", shareImages: name === "luna-image", keyEnv: "BENCHMARK_UNUSED_KEY" });
      if (name !== "lexical") storeProviderKey("openrouter", key!);
      const result = await worker(name, providerDir, name === "luna-image" ? visual : undefined);
      measured.push(result);
      if (measured.reduce((sum, item) => sum + item.decisions.paidCalls, 0) > 18) throw new Error("Cloud call cap exceeded");
      process.stderr.write(`Measured ${name}: ${result.accuracy.total.correct}/12 targets, ${result.decisions.paidCalls} requests\n`);
    }
    const imageFile = output.replace(/\.json$/, "-fixture.jpg");
    const runtimeFiles = ["native-host/src/semantic-search.ts", "native-host/src/decisions/search.ts", "native-host/src/decisions/provider.ts", "native-host/src/decisions/budget.ts"];
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), packageVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
      scope: "In-process component target accuracy and selection latency over fixed synthetic page units; not end-to-end browser-agent task success",
      fixture: { sha256: fixtureHash, queries: 12, units: 30, rounds: 1, multipleAcceptedTargets: { emails: ["n12", "n26", "n28"] } },
      scriptSha256: hash(fs.readFileSync(script)), captureScriptSha256: hash(fs.readFileSync(path.join(root, "scripts/fixtures/capture-accuracy-image.mjs"))),
      runtimeSha256: Object.fromEntries(runtimeFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
      configuration: { cloudOptIn: cloud, mode: "lexical", maxResults: 5, decisionCandidateCap: 16, decisionDeadlineMs: 1500, maxPaidCalls: 18, retries: 0, isolatedProcessPerArm: true },
      screenshot: visual ? { file: path.basename(imageFile), sha256: hash(visual.bytes), format: "jpeg", bytes: visual.bytes.length,
        viewport: { width: 1100, height: 1100 }, browser: { engine: "chromium", version: visual.version }, boxes: visual.boxes } : null,
      limitations: ["Twelve synthetic queries are not a general browser-agent benchmark; no planning or browser actions are measured.",
        "Accuracy is top-1 with local fallback on provider abstention/timeout, not raw model-only accuracy.",
        "One round per arm, sequential fixed task order; latencies include first-call/network setup and are not stable service estimates.",
        "Decisions can only rerank the lexical candidate pool; an absent accepted target cannot be recovered, even with an image.",
        "Provider-reported tokens/cost may be missing; aborted requests may incur unreported charges."], arms: measured };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (visual) fs.writeFileSync(imageFile, visual.bytes);
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(output.replace(/\.json$/, ".svg"), chart(report));
    process.stdout.write(JSON.stringify({ scope: report.scope, fixtureSha256: fixtureHash, arms: measured.map(({ samples, ...summary }) => summary) }, null, 2) + "\n");
  } finally {
    if (previousProviderDir === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR;
    else process.env.AGENT_BROWSER_PROVIDER_DIR = previousProviderDir;
    key = undefined;
    // Only the directory created above may be recursively removed.
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("opencode-accuracy-")) throw new Error("Unexpected benchmark temporary directory");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(() => { process.stderr.write("Benchmark failed; no credentials or local paths are included in diagnostics.\n"); process.exitCode = 1; });
