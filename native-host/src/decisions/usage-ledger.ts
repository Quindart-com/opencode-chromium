import fs from "node:fs";
import { legacyDecisionIdentity } from "../../../src/shared/decision-catalog.ts";
import { record } from "../../../src/shared/values.ts";
import type { UsageDay,UsagePeriod,UsageProvider,UsageQuery,UsageReport,UsageTotals } from "../../../src/shared/decision-usage.ts";

const empty = (): UsageTotals => ({ calls: 0, selected: 0, abstained: 0, tests: 0, inputTokens: 0, outputTokens: 0,
  reportedCost: 0, costReportedCalls: 0, usageReportedCalls: 0, averageMs: 0, lastMs: 0 });
function identity(row: Record<string, unknown>) {
  const model = typeof row.model === "string" && /^[\w/.+-]{1,100}$/.test(row.model) ? row.model : null;
  let provider = row.provider, route = row.route;
  // Never attribute unidentifiable historical records to the current service.
  if (!["jev", "openai-decisions"].includes(String(provider)) || !["openai", "openrouter", "typesafe"].includes(String(route))) {
    const identity = legacyDecisionIdentity(model);
    route = identity?.route ?? "unattributed"; provider = identity?.provider ?? "unknown";
  }
  return { id: String(route) + ":" + String(provider), provider: String(provider), route: String(route), model };
}
function add(target: UsageTotals, value: UsageTotals) {
  const time = target.averageMs * target.calls + value.averageMs * value.calls;
  for (const key of ["calls", "selected", "abstained", "tests", "inputTokens", "outputTokens", "reportedCost", "costReportedCalls", "usageReportedCalls"] as const) target[key] += value[key];
  target.averageMs = target.calls ? time / target.calls : 0; target.lastMs = value.lastMs;
}
const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
interface Bucket { provider: ReturnType<typeof identity>; at: number; totals: UsageTotals }
interface Ledger { offset: number; pending: string; inode: number; mtime: number; buckets: Map<string, Bucket> }
const ledgers = new Map<string, Ledger>();
function aggregate(row: Record<string, unknown>, ledger: Ledger) {
  if (typeof row.at !== "number" || !Number.isFinite(row.at) || row.at < 0 || row.at > 8.64e15) return;
  const source = identity(row), date = new Date(row.at).toISOString().slice(0, 10), key = date + "|" + source.id;
  const bucket = ledger.buckets.get(key) ?? { provider: source, at: row.at, totals: empty() };
  const usage = record(row.usage), elapsedMs = nonnegative(row.elapsedMs), hasUsage = row.usage !== null && typeof row.usage === "object";
  const totals = { ...empty(), calls: 1, tests: Number(row.purpose === "test"), selected: Number(row.status === "selected"),
    abstained: Number(row.status !== "selected"), averageMs: elapsedMs, lastMs: elapsedMs,
    usageReportedCalls: Number(hasUsage), inputTokens: nonnegative(usage.input_tokens), outputTokens: nonnegative(usage.output_tokens),
    costReportedCalls: Number(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0), reportedCost: nonnegative(usage.cost) };
  const previousLast = bucket.totals.lastMs;
  add(bucket.totals, totals);
  if (row.at < bucket.at) bucket.totals.lastMs = previousLast; else bucket.at = row.at;
  ledger.buckets.set(key, bucket);
}
function readLedger(location: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(location, "r");
    const stat = fs.fstatSync(fd);
    let ledger = ledgers.get(location);
    if (!ledger || stat.ino !== ledger.inode || stat.size < ledger.offset || stat.size === ledger.offset && stat.mtimeMs !== ledger.mtime) {
      ledger = { offset: 0, pending: "", inode: stat.ino, mtime: stat.mtimeMs, buckets: new Map() }; ledgers.set(location, ledger);
    }
    // Fold all history once, in bounded chunks, then only appended bytes.
    // Daily aggregates make year/all-time totals accurate without raw-row caches.
    const bytes = Buffer.alloc(65536);
    while (ledger.offset < stat.size) {
      const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - ledger.offset), ledger.offset);
      if (!count) break;
      ledger.offset += count;
      const lines = (ledger.pending + bytes.toString("utf8", 0, count)).split("\n");
      ledger.pending = lines.pop() ?? "";
      for (const line of lines) { if (line.length > 8192) continue; try { aggregate(record(JSON.parse(line) as unknown), ledger); } catch { /* Interrupted or malformed append. */ } }
      if (ledger.pending.length > 8192) ledger.pending = "";
    }
    ledger.mtime = stat.mtimeMs;
    return [...ledger.buckets.entries()];
  } catch { ledgers.delete(location); return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function range(period: UsagePeriod, now: number) {
  const date = new Date(now), today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()), day = 86400000;
  if (period === "7d" || period === "30d") return { start: today - (period === "7d" ? 6 : 29) * day, end: now + 1 };
  if (period === "last-week") { const monday = today - ((date.getUTCDay() + 6) % 7) * day; return { start: monday - 7 * day, end: monday }; }
  if (period === "last-year") return { start: Date.UTC(date.getUTCFullYear() - 1, 0, 1), end: Date.UTC(date.getUTCFullYear(), 0, 1) };
  return { start: 0, end: now + 1 };
}
export function usageReport(location: string, query: UsageQuery = {}, now = Date.now()): UsageReport {
  const period = (["7d", "30d", "last-week", "last-year", "all"] as const).find(value => value === query.period) ?? "all";
  const selectedProvider = query.provider ?? "all", bounds = range(period, now), totals = empty();
  const providers = new Map<string, UsageProvider>(), days = new Map<string, UsageDay>();
  const history = readLedger(location).sort((a, b) => a[1].at - b[1].at);
  for (const [, value] of history) if (!providers.has(value.provider.id)) providers.set(value.provider.id, { ...empty(), ...value.provider });
  for (const [key, value] of history) {
    if (value.at < bounds.start || value.at >= bounds.end) continue;
    const row = providers.get(value.provider.id)!;
    add(row, value.totals);
    if (selectedProvider !== "all" && row.id !== selectedProvider) continue;
    add(totals, value.totals);
    const date = key.split("|")[0]!, daily = days.get(date) ?? { ...empty(), date };
    add(daily, value.totals); days.set(date, daily);
  }
  if (period !== "all") for (let at = bounds.start; at < bounds.end; at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10); if (!days.has(date)) days.set(date, { ...empty(), date });
  }
  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), daily: UsageDay[] = [];
  const span = Math.max(1, Math.ceil(ordered.length / 366));
  for (let index = 0; index < ordered.length; index += span) {
    const group = ordered.slice(index, index + span), first = group[0]!, last = group.at(-1)!;
    const bucket = { ...empty(), date: first.date, ...(span > 1 ? { endDate: last.date } : {}) };
    for (const day of group) add(bucket, day);
    daily.push(bucket);
  }
  return { ...totals, window: "Local history · UTC", period, selectedProvider,
    providers: [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)), daily };
}
