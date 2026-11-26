// Drive with newline-delimited JSON over stdin. See README for the scoring protocol.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  browserBinary,
  disposableDirectory,
  startExtension,
} from "../browser/browser.mjs";
import { createMeter, openStdio } from "../browser/transport.mjs";
import { readFixtures } from "./fixtures.mjs";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    executable: { type: "string" },
    tokenizer: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "routing-baseline-v1" },
    operator: { type: "string" },
    "operator-mode": { type: "string" },
    probe: { type: "boolean", default: false },
  },
});
const root = path.resolve(
  values.project ?? fileURLToPath(new URL("../..", import.meta.url)),
);
assert(
  values.out && values.tokenizer && (values.probe || values.operator),
  "Supply --out, --tokenizer and --operator (or --probe)",
);
if (!values.probe && !["autonomous","relayed","guided","replay","fixtureAuthor"].includes(values["operator-mode"])) throw Error("Specify --operator-mode for the trial.");
const out = path.resolve(values.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out); // Never overwrite a completed baseline.
const tokenizer = path.resolve(values.tokenizer);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(tokenizer, "package.json"))).version,
  "3.4.0",
);
const { encode } = await import(
  pathToFileURL(path.join(tokenizer, "esm/encoding/o200k_base.js"))
);
const build = JSON.parse(
  fs.readFileSync(path.join(root, "dist/build-manifest.json")),
);
const { sourceFingerprint } = await import(
  pathToFileURL(path.join(root, "dist/cli/source-fingerprint.js"))
);
assert.equal(
  sourceFingerprint(root),
  build.sourceSha256,
  "Rebuild the measured project",
);
const fixtureSha256 = createHash("sha256")
  .update(fs.readFileSync(new URL("./fixtures.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n"))
  .digest("hex");
const binary = await browserBinary({
  root,
  engine: "chromium",
  executable: values.executable,
});
const meter = createMeter((s) => encode(s).length);
const fixtures = await readFixtures(values.seed);
const disposable = disposableDirectory();
const setupCalls = [],
  rows = [];
const sessionId = "fixture-reads-v1";
const report = {
  seed: values.seed,
  operatorMode: values["operator-mode"],
  operator: values.probe ? "viewport evidence probe" : values.operator,
  build,
  fixtureSha256,
  browserSha256: binary.sha256,
  node: process.version,
  tokenizer: "o200k_base",
  setupCalls,
  rows,
  complete: false,
};
const save = () =>
  fs.writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
let browser, client, input;
const tool = (calls, name, args) =>
  client.request(calls, "tool", "tools/call", {
    name,
    arguments: { ...args, profile: browser.profileId, sessionId },
  });
const print = (data) => console.log(JSON.stringify(data));
try {
  browser = await startExtension({
    root,
    engine: "chromium",
    binary,
    origins: [fixtures.origin],
    headed: false,
    startupMs: 35000,
    ...disposable,
  });
  report.browser = browser.browserVersion;
  client = openStdio({
    entry: browser.launchers.mcp,
    args: ["--allowed-origin", fixtures.origin],
    cwd: disposable.dir,
    env: browser.env,
    deadlineMs: 18000,
    meter,
  });
  report.handshake = await client.initialize(setupCalls);
  const opened = await tool(setupCalls, "browser_session", {
    action: "new-tab",
  });
  const tabId = opened.result.structuredContent.activeTabId;
  if (!values.probe)
    input = createInterface({ input: process.stdin, terminal: false });
  const commands = input?.[Symbol.asyncIterator]();
  for (const task of fixtures.tasks) {
    const calls = [],
      decisions = [];
    await tool(setupCalls, "browser_run", {
      steps: [{ action: "navigate", url: fixtures.origin + task.url }],
    });
    const page = browser.context
      .pages()
      .find((p) => p.url() === fixtures.origin + task.url);
    assert(page, "Fixture navigation failed");
    let imageSeen = false,
      answer = null,
      visible = null;
    if (values.probe) {
      const r = await tool(calls, "browser_observe", { mode: "read", tabId });
      // Only the ordinary textual MCP content delivered in the first response counts.
      const view = JSON.parse(r.text).result?.view ?? "";
      visible = /^\d+$/.test(task.expected)
        ? new RegExp("\\b" + task.expected + "\\b").test(view)
        : null;
    } else {
      print({
        goal: task.prompt,
        step: "Send {tool,args} or {answer}. Browse only the fixture. Give the requested value or abstention.",
      });
      for (let i = 0; i < 9; i++) {
        const next = await commands.next();
        if (next.done) throw Error("Input closed before all answers");
        const cmd = JSON.parse(next.value);
        if (typeof cmd.answer === "string") {
          answer = cmd.answer.trim();
          break;
        }
        assert(
          ["browser_observe", "browser_run", "resource"].includes(cmd.tool),
          "Unsupported command",
        );
        if (i === 8)
          throw Error("Tool-call budget exhausted without an answer");
        decisions.push(cmd);
        try {
          const reply =
            cmd.tool === "resource"
              ? await client.request(calls, "artifact", "resources/read", {
                  uri: cmd.args.uri,
                })
              : await tool(calls, cmd.tool, cmd.args);
          print({ text: reply.text });
          for (const block of reply.result.content ?? [])
            if (block.type === "image") {
              const filename = path.join(
                out,
                task.id +
                  "-" +
                  i +
                  "." +
                  ({
                    "image/png": "png",
                    "image/jpeg": "jpg",
                    "image/webp": "webp",
                  }[block.mimeType] ?? "img"),
              );
              fs.writeFileSync(filename, Buffer.from(block.data, "base64"));
              print({ image: filename });
              imageSeen = true;
            }
        } catch (e) {
          print({ error: e.code ?? e.message });
        }
      }
    }
    const sourceOk =
      task.evidence === "published"
        ? page.url() === fixtures.origin + "/published/seats"
        : page.url() === fixtures.origin + task.url &&
          (task.evidence !== "image" || imageSeen);
    meter.measure(calls);
    rows.push({
      id: task.id,
      goal: task.prompt,
      evidence: task.evidence,
      calls,
      decisions,
      answer,
      sourceOk,
      correct: values.probe
        ? null
        : answer === task.expected &&
          sourceOk &&
          calls.some((c) => c.outcome === "ok"),
      firstReadContainsExpectedNumber: visible,
    });
    meter.measure(setupCalls);
    save();
  }
  await tool(setupCalls, "browser_finalize", {});
  meter.measure(setupCalls);
  report.complete = true;
  save();
  print({ report: path.join(out, "results.json"), completed: rows.length });
} finally {
  input?.close();
  try {
    await client?.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await fixtures.close();
      } finally {
        disposable.remove();
      }
    }
  }
}
