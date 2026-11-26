#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startAdapter } from "./adapters.mjs";
import { browserBinary, disposableDirectory, json, sampleHost, startCdpBrowser, startExtension } from "./browser.mjs";
import { fixtureHash, hash, schedule, viewport } from "./catalog.mjs";
import { startLedger, verify } from "./ledger.mjs";
import { outcome, schemaVersion, summarize } from "./report.mjs";
import { createMeter, errorRecord } from "./transport.mjs";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(harnessDir, "../..");
const now = () => new Date().toISOString();
const help = `node benchmarks/browser/run.mjs [options]
  --suite smoke|full|load|faults     Default smoke, two rounds of five actions
  --engine chromium|firefox|librewolf|waterfox
  --executable PATH                 Override the browser executable
  --playwright-mcp PATH             Directory of the installed @playwright/mcp@0.0.86
  --devtools-mcp PATH               Directory of the installed chrome-devtools-mcp@1.13.0
  --cdp-attach                      Attach the comparator to a harness-created Chromium tab
  --tokenizer PATH                  Directory of the installed gpt-tokenizer@3.4.0
  --project PATH                    Built runtime checkout (default: harness checkout)
  --revision SHA                    Label a built source archive without Git metadata
  --seed STRING --rounds N --round-offset N
  --matrix 1,2,4,8,16               Default for load; use a subset for a quick run
  --deadline-ms N --startup-ms N --verify-ms N
  --input-mode auto|pointer         Default auto accepts the product's background input route
  --observation viewport|targeted  Default viewport; targeted reads a known ID after navigation
  --managed                         Use the disposable MCP supervisor launcher
  --headed                          Show the disposable browser window
  --out PATH                        New report directory under reports/ by default`;

function options() {
  const strings = ["suite", "engine", "executable", "playwright-mcp", "devtools-mcp", "tokenizer", "project", "revision", "seed", "rounds",
    "round-offset", "matrix", "deadline-ms", "startup-ms", "verify-ms", "input-mode", "observation", "out"];
  const booleans = ["help", "headed", "managed", "cdp-attach"];
  const flags = Object.fromEntries([...strings.map(name => [name, { type: "string" }]), ...booleans.map(name => [name, { type: "boolean" }])]);
  const { values } = parseArgs({ options: flags });
  if (values.help) return null;
  const number = (name, fallback, min, max) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer in ${min}..${max}`);
    return value;
  };
  const suite = values.suite ?? (values.matrix ? "load" : "smoke");
  const engine = values.engine ?? "chromium";
  const inputMode = values["input-mode"] ?? "auto";
  const observationPolicy = values.observation ?? "viewport";
  const root = fs.realpathSync(values.project ?? harnessRoot);
  const absolute = name => values[name] ? path.resolve(values[name]) : null;
  const playwright = absolute("playwright-mcp");
  const devtools = absolute("devtools-mcp");
  if (playwright && devtools) throw new Error("Choose one comparator per run");
  const comparator = playwright ?? devtools;
  const comparatorName = playwright ? "playwright" : devtools ? "devtools" : null;
  const cdpAttach = values["cdp-attach"] === true;
  const matrix = (values.matrix ?? (suite === "load" ? "1,2,4,8,16" : "1")).split(",").map(Number);
  if (!["smoke", "full", "load", "faults"].includes(suite)) throw new Error("Unknown --suite");
  if (!["chromium", "firefox", "librewolf", "waterfox"].includes(engine)) throw new Error("Unknown --engine");
  if (!["auto", "pointer"].includes(inputMode)) throw new Error("Unknown --input-mode");
  if (!["viewport", "targeted"].includes(observationPolicy)) throw new Error("Unknown --observation");
  if (matrix.some(n => ![1, 2, 4, 8, 16].includes(n)) || new Set(matrix).size !== matrix.length) throw new Error("--matrix needs distinct sizes from 1,2,4,8,16");
  if (comparator && (engine !== "chromium" || suite === "load" || values.managed)) throw new Error("Comparators support single-client Chromium smoke, full, and fault runs");
  if (cdpAttach && !comparator) throw new Error("--cdp-attach requires a comparator");
  if (observationPolicy === "targeted" && (comparator || suite === "faults")) throw new Error("Targeted observations require the OpenCode adapter and an ordinary action suite");
  if (values.matrix && suite !== "load") throw new Error("Use --suite load with --matrix");
  const seed = values.seed ?? "pilot-v1";
  if (!seed.length || seed.length > 80) throw new Error("--seed must contain 1..80 characters");
  return { root, engine, inputMode, observationPolicy, comparator, comparatorName, cdpAttach, seed, suite, matrix, executable: absolute("executable"), tokenizer: absolute("tokenizer"),
    revision: values.revision, out: absolute("out"), headed: !!values.headed, managed: !!values.managed, rounds: number("rounds", 2, 1, 30),
    roundOffset: number("round-offset", 0, 0, 100000), deadlineMs: number("deadline-ms", 25000, 100, 120000),
    startupMs: number("startup-ms", 35000, 1000, 120000), verifyMs: number("verify-ms", 1500, 100, 10000) };
}

function git(root, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args],
    { windowsHide: true, encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function provenance(config) {
  const { root, engine, revision, comparator } = config;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const gitRoot = top && path.relative(root, fs.realpathSync(top)) === "";
  const commit = gitRoot ? git(root, ["rev-parse", "HEAD"]) : null;
  if (revision && (!/^[a-f\d]{40}$/i.test(revision) || (commit && revision !== commit))) throw new Error("--revision must be a full SHA and agree with checkout HEAD");
  if (!commit && !revision) throw new Error("No Git revision found for --project. Supply --revision for a built source archive.");
  const extension = engine === "chromium" ? "extension" : "extension-firefox";
  const hashes = comparator ? {} : Object.fromEntries([`${extension}/background.js`, `${extension}/manifest.json`, "dist/adapters/mcp/server.js", "native-host/dist/runtime.js"]
    .map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const build = comparator ? null : json(path.join(root, "dist/build-manifest.json"));
  if (build) {
    const { sourceFingerprint } = await import(pathToFileURL(path.join(root, "dist/cli/source-fingerprint.js")));
    if (build.sourceSha256 !== sourceFingerprint(root)) throw new Error("Runtime build does not match its source tree. Rebuild --project before measuring.");
  }
  return { commit: commit ?? revision, revisionSource: commit ? "git" : "supplied", tree: commit ? git(root, ["rev-parse", "HEAD^{tree}"]) : null,
    runtimeDirty: commit ? git(root, ["status", "--porcelain", "--", "src", "native-host/src", "extension-src", "scripts", "package.json", "bun.lock", "wxt.config.ts"]) !== "" : null,
    packageVersion: json(path.join(root, "package.json")).version, build, hashes };
}

async function tokenizer(directory) {
  if (!directory) return { encode: null, name: null };
  const pkg = json(path.join(directory, "package.json"));
  if (pkg.name !== "gpt-tokenizer" || pkg.version !== "3.4.0") throw new Error("Use gpt-tokenizer@3.4.0 for comparable token counts");
  const { encode } = await import(pathToFileURL(path.join(directory, "esm/encoding/o200k_base.js")));
  return { encode: text => encode(text).length, name: "gpt-tokenizer@3.4.0/o200k_base" };
}

async function startSentinel(context, ledger) {
  if (!context) return null;
  const route = ledger.register(null, "sentinel");
  const page = await context.newPage();
  await page.goto(route.url);
  await page.bringToFront();
  await page.locator("#sentinel").focus();
  const before = await route.read();
  const firstSequence = Math.max(0, ...before.events.map(event => event.seq));
  let stop = false, typed = 0, unfocusedSamples = 0, error;
  const running = (async () => {
    try {
      while (!stop) {
        if (!await page.evaluate(() => document.hasFocus() && !document.hidden)) unfocusedSamples++;
        if (typed < 1000) { await page.keyboard.press("x"); typed++; }
        await delay(80);
      }
    } catch (cause) { error = errorRecord(cause, "sentinel"); }
  })();
  return async () => {
    stop = true;
    await running;
    const state = await route.read();
    const input = state.events.filter(event => event.type === "typing" && event.seq > firstSequence);
    const focusLoss = state.events.filter(event => event.type === "focus" && event.seq > firstSequence && (!event.focused || !event.visible)).length;
    const received = input.sort((a, b) => a.seq - b.seq).at(-1)?.value ?? "";
    return { status: error ? "failed" : "observed", typed, received: received.length, focusLoss, unfocusedSamples,
      incorrectInput: typed === 0 || received !== "x".repeat(typed) || input.length !== typed || input.some(event => !event.trusted) || state.overflow,
      error: error ?? null };
  };
}

async function raceClaim(context, ledger, clients) {
  if (!context || clients.length < 2) return { status: "untested", reason: "Needs two ready clients and an independent Chromium tab opener", calls: [] };
  const routes = ledger.register(null, "claim");
  const page = await context.newPage();
  await page.goto(routes.url);
  const calls = [];
  const contenders = clients.slice(0, 2).map(client => client.driver);
  try {
    const offers = await Promise.all(contenders.map(client => client.listTabs(calls, routes.url, "user")));
    const id = offers[0][0];
    if (offers.some(ids => ids.length !== 1 || ids[0] !== id)) return { status: "failed", code: "CLAIM_DISCOVERY", calls };
    // This fresh fixture tab is explicitly authorized for both test clients.
    const prepared = await Promise.allSettled(contenders.map(client => client.prepareClaim(calls, id)));
    const result = await Promise.allSettled(prepared.map((approval, index) => approval.status === "fulfilled"
      ? contenders[index].confirmClaim(calls, approval.value) : Promise.reject(approval.reason)));
    const owners = await Promise.all(contenders.map(client => client.listTabs(calls, routes.url, "session")));
    const winner = result.findIndex(row => row.status === "fulfilled");
    const rejected = result.map(row => row.status === "rejected" ? row.reason.code : null);
    const sideEffects = (await routes.read()).events.filter(event => event.type === "effect" || event.type === "draft").length;
    const ok = winner !== -1 && rejected.filter(Boolean).length === 1 && !rejected.includes("TIMEOUT") && owners.every((owned, i) => i === winner ? owned.length === 1 : owned.length === 0) && sideEffects === 0;
    return { status: ok ? "passed" : "failed", winner, rejected, ownership: owners.map(owned => owned.length), sideEffects, calls };
  } catch (error) { return { status: "failed", error: errorRecord(error, "claim_race"), calls }; }
}

async function checkEffect(task, route, deadlineMs) {
  const started = performance.now();
  let record;
  do {
    record = verify(task, await route.read(Math.max(1, Math.ceil(deadlineMs - (performance.now() - started)))));
    if (record.ok || record.effects.some(effect => effect.key !== task.expected?.effect) || record.issues.includes("EXTRA_EFFECT")) break;
    if (record.issues.every(issue => issue === "MISSING_EFFECT" || issue === "DRAFT_NOT_SAVED") && task.fault === "lookup") break;
    await delay(35);
  } while (performance.now() - started < deadlineMs);
  return record;
}

async function runWave(config, clients, ledger, meter, binary) {
  const started = performance.now();
  const disposable = disposableDirectory();
  const topology = config.cdpAttach ? "cdp-attached-disposable-chromium" : config.comparatorName === "devtools" ? "isolated-devtools-browser"
    : config.comparator ? "isolated-Playwright-context" : "shared-disposable-extension-profile";
  const wave = { kind: "wave", clients, startedAt: now(), topology,
    browser: null, startupMs: null, actionWindowMs: 0, sessionMs: null, host: null, sentinel: null, claimRace: null, cleanupFailures: [] };
  const attempts = [];
  const lanes = Array.from({ length: clients }, (_, client) => {
    const tasks = Array.from({ length: config.rounds }, (_, i) => schedule({ ...config, round: config.roundOffset + i, client })).flat();
    return { tasks, row: { kind: "client", clients, client, calls: [], startedAt: now() } };
  });
  let fixture, stopSentinel, hostBefore;
  const cleanup = async (phase, operation) => {
    try { await operation(); } catch (error) { wave.cleanupFailures.push(errorRecord(error, phase)); }
  };
  try {
    if (!config.comparator) fixture = await startExtension({ ...config, ...disposable, binary, origins: ledger.origins });
    if (config.cdpAttach) fixture = await startCdpBrowser({ ...config, ...disposable, binary, origins: ledger.origins, attachUrl: ledger.register(null, "claim").url });
    wave.browser = { version: fixture?.browserVersion ?? binary.expectedVersion, name: fixture?.browserName ?? config.engine,
      extensionVersion: fixture?.extensionVersion ?? null, handshakeRetried: fixture?.handshakeRetried ?? false,
      versionSource: fixture?.browserVersion ? config.engine === "chromium" ? "browser" : "native-registration" : binary.versionSource };
    wave.startupMs = performance.now() - started;
    await Promise.all(lanes.map(async lane => {
      const { row } = lane;
      const setupStarted = performance.now();
      let phase = "initialize";
      try {
        lane.driver = startAdapter({ ...config, ...disposable, fixture, binary, origins: ledger.origins, meter, sessionId: `bench-${clients}-${row.client}` });
        row.handshake = await lane.driver.initialize(row.calls);
        lane.initialized = true;
        phase = "setup";
        await lane.driver.setup(row.calls);
      } catch (error) { row.startupError = errorRecord(error, phase); }
      row.setupMs = performance.now() - setupStarted;
    }));
    if (config.suite === "load") {
      hostBefore = sampleHost(fixture?.hostPid);
      wave.sentinel = { status: "untested", reason: "An independent foreground input connection is unavailable in this topology" };
      try { stopSentinel = await startSentinel(fixture?.context, ledger); }
      catch (error) { wave.sentinel = { status: "failed", error: errorRecord(error, "sentinel_start") }; }
    }
  } catch (error) {
    wave.error = errorRecord(error, "startup");
    wave.startupMs = performance.now() - started;
  }

  const actionStart = performance.now();
  for (let index = 0; index < lanes[0].tasks.length; index++) {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const trial = lanes.map(async lane => {
      const task = lane.tasks[index];
      const row = { kind: "attempt", clients, client: task.client, round: task.round, slot: index, task: task.id, app: task.app, goal: task.goal,
        fixtureHash: fixtureHash(task), initial: task.initial, expected: task.expected, allowedActions: task.allowedActions, holdout: task.holdout,
        slow: task.slow, guard: task.guard, fault: task.fault, calls: [], startedAt: null, wallMs: null,
        queueMs: null, firstObservationMiss: null, agentConfirmed: false, verification: null, outcome: "not_started" };
      const route = ledger.register(task);
      attempts.push({ row, route, task });
      const queued = performance.now();
      await barrier;
      row.startedAt = now();
      const start = performance.now();
      row.barrierWaitMs = start - queued;
      if (wave.error || lane.row.startupError) {
        row.error = wave.error ?? lane.row.startupError;
        row.endedAt = now();
        return;
      }
      const progress = { phase: "lookup", firstObservationMiss: null };
      try { row.agentConfirmed = await lane.driver.act({ goal: task.goal, url: route.url, calls: row.calls, fault: task.fault, progress }); }
      catch (error) { row.error = errorRecord(error, error.phase ?? progress.phase); }
      row.firstObservationMiss = progress.firstObservationMiss;
      const verificationStart = performance.now();
      try {
        const mightHaveActed = row.calls.some(call => call.execution === "unknown" || call.execution === "acknowledged");
        row.verification = await checkEffect(task, route, mightHaveActed ? config.verifyMs : Math.min(config.verifyMs, 250));
      } catch (error) { row.verifierError = errorRecord(error, "verification"); }
      row.verificationMs = performance.now() - verificationStart;
      row.wallMs = performance.now() - start;
      row.endedAt = now();
    });
    release();
    await Promise.all(trial);
  }
  wave.actionWindowMs = performance.now() - actionStart;

  if (config.suite === "load") {
    const after = sampleHost(fixture?.hostPid);
    wave.host = { before: hostBefore ?? null, after, cpuMs: hostBefore && after ? after.cpuMs - hostBefore.cpuMs : null };
    if (stopSentinel) await cleanup("sentinel_stop", async () => { wave.sentinel = await stopSentinel(); });
    await cleanup("claim_race", async () => { wave.claimRace = await raceClaim(fixture?.context, ledger, lanes.filter(lane => !lane.row.startupError)); });
  }
  await Promise.all(lanes.map(async lane => {
    if (lane.initialized) await cleanup("finalize", async () => { await lane.driver.finalize(lane.row.calls); });
    await cleanup("client_stop", async () => { await lane.driver?.close(); });
    lane.row.endedAt = now();
  }));
  if (fixture?.attachPage) {
    const { attachPage, originalTabs } = fixture;
    const originalTabOpen = !attachPage.isClosed();
    const otherTabsPreserved = originalTabs.every(({ page, url }) => !page.isClosed() && page.url() === url);
    const originalTabReused = originalTabOpen && attempts.at(-1).route.url === attachPage.url();
    wave.attachment = { authorization: "harness-owned-fixture", originalTabOpen, originalTabReused, otherTabsPreserved,
      verified: originalTabReused && otherTabsPreserved };
    if (!wave.attachment.verified) wave.cleanupFailures.push({ phase: "attachment_verify", code: "ATTACHMENT_VERIFICATION", message: "The comparator did not reuse and preserve the expected disposable tab" });
  }
  if (fixture) await cleanup("browser_stop", fixture.close);
  await cleanup("profile_remove", disposable.remove);
  // Re-read every ledger after all clients stop. A late side effect on an
  // earlier or another client's tab invalidates its provisional success.
  await Promise.all(attempts.map(async ({ row, route, task }) => {
    if (!Number.isFinite(row.wallMs)) return;
    try {
      const final = verify(task, await route.read());
      if (row.verification && JSON.stringify(row.verification) !== JSON.stringify(final)) row.changedAfterVerification = true;
      const deadlineMissed = final.ok && !row.verification?.ok && !task.fault;
      row.verification = final;
      if (deadlineMissed) row.verifierError ??= { phase: "verification", code: "VERIFY_DEADLINE", message: "The fixture effect was first seen after the attempt deadline" };
      row.outcome = deadlineMissed ? "failed" : outcome(task, final, row.error);
    } catch (error) { row.verifierError = errorRecord(error, "verification_tail"); row.outcome = "failed"; }
  }));
  wave.sessionMs = performance.now() - started;
  wave.endedAt = now();
  const rows = [wave, ...lanes.map(lane => lane.row), ...attempts.map(attempt => attempt.row)];
  meter.measure(rows.flatMap(row => row.calls ?? row.claimRace?.calls ?? []));
  return rows;
}

async function main() {
  const config = options();
  if (!config) { console.log(help); return; }
  if (process.versions.bun || Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use Node 24 or later for the browser runner");
  const { encode, name } = await tokenizer(config.tokenizer);
  const target = await provenance(config);
  const comparePackage = config.comparator && json(path.join(config.comparator, "package.json"));
  const comparePin = config.comparatorName === "devtools" ? "chrome-devtools-mcp@1.13.0" : "@playwright/mcp@0.0.86";
  if (comparePackage && comparePackage.name + "@" + comparePackage.version !== comparePin) throw new Error("Use " + comparePin + " for this comparator");
  const binary = await browserBinary(config);
  const sources = fs.readdirSync(harnessDir).filter(file => file.endsWith(".mjs")).sort();
  const run = { kind: "run", schemaVersion, startedAt: now(), target, harnessSha256: hash(sources.map(file => fs.readFileSync(path.join(harnessDir, file), "utf8").replaceAll("\r\n", "\n")).join("\n")),
    node: process.version, platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model ?? null,
    browser: { engine: config.engine, binarySha256: binary.sha256, expectedVersion: binary.expectedVersion, driverVersion: binary.driverVersion, headed: config.headed },
    adapter: comparePackage ? comparePin : config.managed ? "opencode-mcp-managed" : "opencode-mcp-direct",
    tokenizer: name, modelUsage: null, viewport, inputMode: config.inputMode, observationPolicy: config.observationPolicy,
    seed: config.seed, suite: config.suite, matrix: config.matrix, rounds: config.rounds,
    roundOffset: config.roundOffset, deadlines: { callMs: config.deadlineMs, startupMs: config.startupMs, verifyMs: config.verifyMs } };
  const defaultParent = path.join(harnessRoot, "reports", "verified-browser");
  fs.mkdirSync(config.out ? path.dirname(config.out) : defaultParent, { recursive: true });
  const out = config.out ?? fs.mkdtempSync(path.join(defaultParent, "run-"));
  if (config.out) fs.mkdirSync(out);
  const log = path.join(out, "results.jsonl");
  const append = rows => fs.appendFileSync(log, rows.map(row => JSON.stringify(row) + "\n").join(""));
  append([run]);
  const ledger = await startLedger();
  const rows = [];
  try {
    for (const clients of config.matrix) {
      process.stderr.write(`Running ${config.suite} with ${clients} client${clients === 1 ? "" : "s"}\n`);
      const wave = await runWave(config, clients, ledger, createMeter(encode), binary);
      rows.push(...wave);
      append(wave);
    }
  } finally { await ledger.close(); }
  const summary = summarize(run, rows);
  fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, matrix: summary.matrix.map(row => ({ clients: row.clients, attempts: row.attempts, verified: row.verified,
    guards: row.guards, probes: row.probes, p95Ms: row.latency.all.p95Ms, startupFailure: row.startupFailure })) }));
  if (rows.some(row => ["failed", "not_started", "blocked"].includes(row.outcome) || row.cleanupFailures?.length || row.claimRace?.status === "failed" ||
    row.sentinel?.incorrectInput || row.sentinel?.focusLoss || row.sentinel?.unfocusedSamples || row.sentinel?.status === "failed")) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 2; });
