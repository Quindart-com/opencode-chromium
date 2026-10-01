import fs from "node:fs";
import path from "node:path";
import { providerSettingsPath } from "./settings.js";
import type { DecisionResult } from "./provider.js";

const file = () => path.join(path.dirname(providerSettingsPath()), "usage.jsonl");
export function recordDecision(result: DecisionResult, purpose: string): void {
  // Append small records so independent profile hosts don't overwrite totals.
  // No key, query, page text, recipe, or candidate ID is retained.
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file(), JSON.stringify({ at: Date.now(), purpose, status: result.status,
      elapsedMs: result.elapsedMs, usage: result.usage }) + "\n", { mode: 0o600 });
  } catch { /* Accounting failure must never retry a billed request. */ }
}
export function decisionUsage() {
  const totals = { calls: 0, selected: 0, abstained: 0, tests: 0, inputTokens: 0, outputTokens: 0,
    reportedCost: 0, costReportedCalls: 0, usageReportedCalls: 0, averageMs: 0, lastMs: 0 };
  let time = 0;
  try {
    // A bounded read keeps popup polling cheap, even after years of use.
    const fd = fs.openSync(file(), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 2_000_000);
      const bytes = Buffer.alloc(length);
      fs.readSync(fd, bytes, 0, length, size - length);
      const lines = bytes.toString("utf8").split("\n");
      if (size > length) lines.shift();
      for (const line of lines) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          totals.calls++; totals.tests += Number(row.purpose === "test");
          totals.selected += Number(row.status === "selected"); totals.abstained += Number(row.status !== "selected");
          totals.lastMs = Number(row.elapsedMs) || 0; time += totals.lastMs;
          if (row.usage) {
            totals.usageReportedCalls++;
            totals.inputTokens += Number(row.usage.input_tokens) || 0;
            totals.outputTokens += Number(row.usage.output_tokens) || 0;
            if (typeof row.usage.cost === "number") { totals.reportedCost += row.usage.cost; totals.costReportedCalls++; }
          }
        } catch { /* Ignore incomplete records after an interrupted append. */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* No calls yet. */ }
  totals.averageMs = totals.calls ? time / totals.calls : 0;
  return { ...totals, window: "Most recent 2 MB of local usage records" };
}
