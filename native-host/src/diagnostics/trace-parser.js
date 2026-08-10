const MICROS_PER_MS = 1000;

function frameId(event) {
  return event?.args?.data?.frame ?? event?.args?.frame ?? null;
}

function eventMs(event) {
  return Number.isFinite(event.ts) ? event.ts / MICROS_PER_MS : null;
}

function durationMs(event) {
  return Number.isFinite(event.dur) ? event.dur / MICROS_PER_MS : null;
}

function nameMatches(event, pattern) {
  return typeof event?.name === "string" && pattern.test(event.name);
}

// Extracts pragmatic performance metrics from a flat Chrome tracing event
// array. Durations arrive in microseconds; all reported values are
// milliseconds or unitless scores. Categories are matched loosely so the
// parser degrades gracefully when a trace omits a category.
export function parseTrace(events) {
  const list = Array.isArray(events) ? events : [];
  const metrics = {
    navigationStart: null,
    FCP: null,
    LCP: null,
    CLS: 0,
    layoutShiftCount: 0,
    longTaskCount: 0,
    worstLongTaskMs: 0,
    TBT: 0,
    mainThreadMs: 0,
    jsMs: 0,
    documentUrl: null,
    documentDurationMs: null,
    renderBlockingCount: 0,
    images: [],
    imageCount: 0,
    imageLoadMs: 0,
    thirdParty: {},
    resources: 0,
    transferBytes: 0,
    eventCount: list.length,
  };

  const resourceStarts = new Map();
  const resourceFinishes = new Map();

  for (const event of list) {
    const name = event?.name ?? "";
    const ph = event?.ph ?? "";
    const category = String(event?.cat ?? "");

    if (ph === "R" && nameMatches(event, /^navigationStart$/i)) {
      metrics.navigationStart = metrics.navigationStart ?? eventMs(event);
      metrics.documentUrl = event?.args?.data?.documentLoaderURL ?? metrics.documentUrl;
      continue;
    }
    if (ph === "R" && nameMatches(event, /firstContentfulPaint/i)) {
      if (metrics.FCP === null) metrics.FCP = eventMs(event);
      continue;
    }
    if (nameMatches(event, /LargestContentfulPaint::Candidate/i)) {
      metrics.LCP = eventMs(event);
      continue;
    }
    if (name === "LayoutShift" && (ph === "I" || ph === "R")) {
      const data = event.args?.data ?? {};
      if (data.had_recent_input === true) continue;
      const score = Number(data.score ?? 0);
      if (Number.isFinite(score)) {
        metrics.CLS += score;
        metrics.layoutShiftCount += 1;
      }
      continue;
    }
    if (name === "RunTask" && ph === "X") {
      const duration = durationMs(event);
      if (duration === null) continue;
      metrics.mainThreadMs += duration;
      if (duration > 50) {
        metrics.longTaskCount += 1;
        metrics.worstLongTaskMs = Math.max(metrics.worstLongTaskMs, duration);
        metrics.TBT += duration - 50;
      }
      continue;
    }
    if (name === "EvaluateScript" && ph === "X") {
      metrics.jsMs += durationMs(event) ?? 0;
      continue;
    }

    const data = event.args?.data ?? {};
    if (name === "ResourceSendRequest") {
      const url = typeof data.url === "string" ? data.url : null;
      if (!url) continue;
      resourceStarts.set(String(data.requestId ?? url), {
        url,
        type: String(data.resourceType ?? ""),
        priority: String(data.priority ?? ""),
        startMs: eventMs(event),
      });
      continue;
    }
    if (name === "ResourceFinish") {
      const requestId = String(data.requestId ?? "");
      const start = resourceStarts.get(requestId);
      const finishMs = eventMs(event);
      const transfer = Number(data.transferSize ?? 0);
      if (Number.isFinite(transfer)) metrics.transferBytes += transfer;
      if (start) {
        resourceFinishes.set(requestId, { start, finishMs, transfer });
        metrics.resources += 1;
        const type = start.type;
        if (type === "Document" && metrics.documentDurationMs === null && finishMs) {
          metrics.documentDurationMs = finishMs - (start.startMs ?? finishMs);
          metrics.documentUrl = start.url ?? metrics.documentUrl;
        }
        if (type === "Img") {
          metrics.imageCount += 1;
          metrics.images.push({ url: start.url, durationMs: finishMs ? finishMs - start.startMs : null });
          if (finishMs && start.startMs) metrics.imageLoadMs += finishMs - start.startMs;
        }
      }
      continue;
    }
    if (category.includes("devtools.timeline") && ph === "R" && nameMatches(event, /^TracingStartedInBrowser$/)) {
      // Marker only; no metric contribution.
    }
  }

  if (metrics.navigationStart === null && list.length > 0) {
    const first = list.reduce((min, event) => (event.ts < min.ts ? event : min), list[0]);
    metrics.navigationStart = eventMs(first);
  }

  const relative = (value) => (value !== null && metrics.navigationStart !== null ? Math.max(0, value - metrics.navigationStart) : null);
  metrics.FCP = relative(metrics.FCP);
  metrics.LCP = relative(metrics.LCP);

  metrics.renderBlockingCount = [...resourceStarts.values()].filter((resource) => {
    if (!["Script", "Stylesheet"].includes(resource.type)) return false;
    if (metrics.FCP !== null && resource.startMs !== null && resource.startMs > metrics.navigationStart + metrics.FCP) return false;
    return true;
  }).length;

  const documentHost = metrics.documentUrl ? new URL(metrics.documentUrl).host : null;
  const thirdParty = {};
  for (const resource of resourceStarts.values()) {
    let host = null;
    try {
      host = new URL(resource.url).host;
    } catch {
      continue;
    }
    if (documentHost && host !== documentHost) {
      thirdParty[host] = thirdParty[host] ?? { requests: 0, transferBytes: 0 };
      thirdParty[host].requests += 1;
      const finish = [...resourceFinishes.values()].find((item) => item.start?.url === resource.url);
      thirdParty[host].transferBytes += finish?.transfer ?? 0;
    }
  }
  metrics.thirdParty = Object.fromEntries(
    Object.entries(thirdParty).sort((a, b) => b[1].transferBytes - a[1].transferBytes).slice(0, 5),
  );

  return metrics;
}