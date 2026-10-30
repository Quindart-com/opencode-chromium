import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageReport } from "../../native-host/src/decisions/usage-ledger.ts";

const now = Date.UTC(2026, 9, 29, 12);
const row = (at: number, extra: object = {}) => ({ at, purpose: "select", status: "selected", elapsedMs: 100,
  usage: { input_tokens: 10, output_tokens: 2 }, ...extra });
function fixture(run: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-usage-"));
  try { run(path.join(dir, "usage.jsonl")); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test("service history remains separated after switching; legacy records use model evidence or remain unattributed", () => fixture(file => {
  fs.writeFileSync(file, [
    row(now - 1, { provider: "openai-decisions", route: "openai", usage: { input_tokens: 50, output_tokens: 0 } }),
    row(now - 2, { model: "openai/gpt-6-luna-decisions" }), row(now - 3, { model: "typesafe/jev-1.13-20260917" }),
    row(now - 4, { model: "gpt-6-luna" }), row(now - 5), row(now - 6, { status: "abstained", provider: "openai-decisions", route: "openai", usage: undefined }),
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const direct = usageReport(file, { provider: "openai:openai-decisions", period: "7d" }, now);
  expect(direct).toMatchObject({ calls: 3, inputTokens: 60, outputTokens: 2, abstained: 1 });
  expect(direct.providers.map(value => value.id)).toEqual(["openai:openai-decisions", "openrouter:jev", "openrouter:openai-decisions", "unattributed:unknown"]);
  expect(usageReport(file, { provider: "openrouter:openai-decisions" }, now)).toMatchObject({ calls: 1, inputTokens: 10 });
  expect(usageReport(file, { provider: "unattributed:unknown" }, now).calls).toBe(1);
}));
test("period boundaries, complete older history and incremental/partial appends are accurate", () => fixture(file => {
  const older = row(Date.UTC(2025, 4, 2), { provider: "jev", route: "typesafe" });
  const recent = row(now - 1000, { provider: "openai-decisions", route: "openai" });
  fs.writeFileSync(file, JSON.stringify(older) + "\n" + (JSON.stringify(recent) + "\n").repeat(16000));
  expect(fs.statSync(file).size).toBeGreaterThan(2000000);
  expect(usageReport(file, { period: "last-year" }, now)).toMatchObject({ calls: 1, inputTokens: 10 });
  const first = usageReport(file, { period: "7d" }, now);
  expect(first.calls).toBe(16000); expect(first.daily).toHaveLength(7);
  const appended = JSON.stringify(row(now - 500));
  fs.appendFileSync(file, appended.slice(0, 20));
  expect(usageReport(file, {}, now).calls).toBe(16001);
  fs.appendFileSync(file, appended.slice(20) + "\n");
  expect(usageReport(file, {}, now).calls).toBe(16002);
  fs.writeFileSync(file, JSON.stringify(older) + "\n");
  expect(usageReport(file, {}, now).calls).toBe(1);
}));
test("last week means the previous UTC Monday-to-Monday interval", () => fixture(file => {
  fs.writeFileSync(file, [row(Date.UTC(2026, 9, 18, 23, 59)), row(Date.UTC(2026, 9, 19)), row(Date.UTC(2026, 9, 25, 23, 59)), row(Date.UTC(2026, 9, 26))]
    .map(value => JSON.stringify(value)).join("\n") + "\n");
  const report = usageReport(file, { period: "last-week" }, now);
  expect(report.calls).toBe(2); expect(report.daily[0]!.date).toBe("2026-10-19"); expect(report.daily.at(-1)!.date).toBe("2026-10-25");
}));
