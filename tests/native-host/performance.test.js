import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePerformanceTrace, performanceInsightById, traceEventsFromChunks } from "../../native-host/src/diagnostics/index.js";

const TS = 1000000;

function event(event) {
  return { pid: 1, tid: 1, ...event };
}

function traceEvents() {
  return [
    event({ name: "navigationStart", cat: "navigation", ph: "R", ts: TS, args: { data: { documentLoaderURL: "https://site.test/" } } }),
    event({ name: "firstContentfulPaint", cat: "blink.user_timing", ph: "R", ts: TS + 500000 }),
    event({ name: "LargestContentfulPaint::Candidate", cat: "loading", ph: "I", ts: TS + 900000, args: { data: { size: 120000 } } }),
    event({ name: "LargestContentfulPaint::Candidate", cat: "loading", ph: "I", ts: TS + 1200000, args: { data: { size: 320000 } } }),
    event({ name: "LayoutShift", cat: "loading", ph: "I", ts: TS + 600000, args: { data: { score: 0.05, had_recent_input: false } } }),
    event({ name: "LayoutShift", cat: "loading", ph: "I", ts: TS + 700000, args: { data: { score: 0.03, had_recent_input: true } } }),
    event({ name: "RunTask", cat: "devtools.timeline", ph: "X", ts: TS + 100000, dur: 40000 }),
    event({ name: "RunTask", cat: "devtools.timeline", ph: "X", ts: TS + 200000, dur: 120000 }),
    event({ name: "EvaluateScript", cat: "devtools.timeline", ph: "X", ts: TS + 150000, dur: 90000 }),
    event({ name: "ResourceSendRequest", cat: "devtools.timeline", ph: "I", ts: TS + 50000, args: { data: { requestId: "doc", url: "https://site.test/", resourceType: "Document" } } }),
    event({ name: "ResourceFinish", cat: "devtools.timeline", ph: "X", ts: TS + 3000000, args: { data: { requestId: "doc", transferSize: 10000 } } }),
    event({ name: "ResourceSendRequest", cat: "devtools.timeline", ph: "I", ts: TS + 100000, args: { data: { requestId: "app.js", url: "https://site.test/app.js", resourceType: "Script" } } }),
    event({ name: "ResourceFinish", cat: "devtools.timeline", ph: "X", ts: TS + 400000, args: { data: { requestId: "app.js", transferSize: 5000 } } }),
    event({ name: "ResourceSendRequest", cat: "devtools.timeline", ph: "I", ts: TS + 200000, args: { data: { requestId: "img", url: "https://cdn.test/hero.png", resourceType: "Img" } } }),
    event({ name: "ResourceFinish", cat: "devtools.timeline", ph: "X", ts: TS + 1000000, args: { data: { requestId: "img", transferSize: 8000 } } }),
  ];
}

test("trace analysis computes LCP, CLS, long tasks, TBT, and JS time", () => {
  const result = analyzePerformanceTrace(traceEvents());
  assert.equal(result.ok, true);
  assert.equal(result.traceEventCount, 15);
  assert.equal(result.summary.FCP, 500);
  assert.equal(result.summary.LCP, 1200);
  assert.equal(result.summary.CLS, 0.05);
  assert.equal(result.summary.longTaskCount, 1);
  assert.equal(result.summary.worstLongTaskMs, 120);
  const tbt = result.summary.TBT;
  assert.ok(tbt >= 69 && tbt <= 71, `TBT should be ~70, got ${tbt}`);
  assert.equal(result.summary.jsMs, 90);
  assert.equal(result.summary.resources, 3);
  assert.equal(result.summary.renderBlockingCount, 1);
  assert.equal(result.summary.imageCount, 1);
  assert.equal(result.summary.documentDurationMs, 2950);
});

test("trace analysis produces eight insights and filters by id", () => {
  const result = analyzePerformanceTrace(traceEvents());
  assert.equal(result.insights.length, 8);
  const ids = result.insights.map((insight) => insight.id);
  assert.ok(ids.includes("lcp"));
  assert.ok(ids.includes("layout-shifts"));
  assert.ok(ids.includes("long-tasks"));
  assert.ok(ids.includes("third-party-cost"));
  const filtered = performanceInsightById(result, "lcp");
  assert.equal(filtered.insights.length, 1);
  assert.equal(filtered.insights[0].id, "lcp");
});

test("trace chunks normalize from strings and arrays", () => {
  const events = traceEventsFromChunks([
    JSON.stringify(traceEvents().slice(0, 2)),
    JSON.stringify(traceEvents()[2]),
    traceEvents().slice(3, 5),
  ]);
  assert.equal(events.length, 5);
});

test("analyze rejects missing traces", () => {
  const result = analyzePerformanceTrace([]);
  assert.equal(result.ok, true);
  assert.equal(result.summary.FCP, null);
  assert.equal(result.summary.LCP, null);
});