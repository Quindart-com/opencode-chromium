import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { render, viewport } from "./catalog.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  if (!server.listening) return;
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

async function readEvent(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error("Fixture event too large");
  }
  const event = JSON.parse(body);
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error("Missing event sequence");
  return event;
}

export async function startLedger() {
  const cases = new Map();
  const documents = new Map();
  const readerKey = randomUUID();
  let origin, frameOrigin;
  const servers = [createServer(), createServer()];
  try {
    origin = await listen(servers[0]);
    frameOrigin = await listen(servers[1]);
  } catch (error) {
    await Promise.all(servers.map(close));
    throw error;
  }

  async function handle(request, response, secondary) {
    const [path, id] = request.url.split("/").slice(1);
    const entry = cases.get(id);
    const here = secondary ? frameOrigin : origin;
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && path === "state" && !secondary && entry && request.headers.authorization === `Bearer ${readerKey}`) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ documents: entry.documents, events: entry.events, overflow: entry.overflow }));
      return;
    }
    if (request.method === "GET" && entry && path === (secondary ? "frame" : "page") && (!secondary || entry.task?.framed)) {
      const channel = secondary ? "frame" : entry.channel;
      const doc = { id: randomUUID(), channel };
      documents.set(doc.id, { entry, doc, here });
      entry.documents.push(doc);
      if (entry.task?.slow && !secondary) await delay(300);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src ${frameOrigin}`);
      response.end(render(entry.task, { channel, endpoint: `/event/${doc.id}`, frameUrl: `${frameOrigin}/frame/${id}` }));
      return;
    }
    const source = documents.get(id);
    if (request.method === "POST" && path === "event" && source?.here === here && (!request.headers.origin || request.headers.origin === here)) {
      const event = await readEvent(request);
      // Append all records, including duplicate events. A dropped record can
      // never produce a pass, even when the fixture runs into its size limit.
      if (source.entry.events.length < 2048) {
        source.entry.events.push({ ...event, doc: source.doc.id, channel: source.doc.channel });
      } else source.entry.overflow = true;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  }

  servers.forEach((server, i) => server.on("request", (req, res) => {
    void handle(req, res, i === 1).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  }));

  return {
    origins: [origin, frameOrigin],
    register(task, channel = "main") {
      const id = randomUUID();
      cases.set(id, { task, channel, documents: [], events: [], overflow: false });
      return {
        url: `${origin}/page/${id}`,
        async read(timeout = 3000) {
          const res = await fetch(`${origin}/state/${id}`, { headers: { authorization: `Bearer ${readerKey}` }, signal: AbortSignal.timeout(timeout) });
          if (!res.ok) throw new Error(`Fixture verifier returned ${res.status}`);
          return res.json();
        },
      };
    },
    async close() { await Promise.all(servers.map(close)); },
  };
}

export function verify(task, state) {
  const { documents, events, overflow } = state;
  const effects = events.filter(event => event.type === "effect");
  const drafts = events.filter(event => event.type === "draft").sort((a, b) => a.seq - b.seq);
  const ready = events.find(event => event.type === "ready" && event.channel === "main");
  const expectedChannel = task.framed ? "frame" : "main";
  const issues = [];
  if (overflow || documents.some(({ id }) => events.filter(event => event.doc === id).map(event => event.seq).sort((a, b) => a - b).some((seq, i) => seq !== i + 1))) issues.push("JOURNAL_INTEGRITY");
  if (documents.length > (task.framed ? 2 : 1)) issues.push("UNEXPECTED_NAVIGATION");
  if (!ready || (task.framed && !events.some(event => event.type === "ready" && event.channel === "frame"))) issues.push("FIXTURE_NOT_READY");
  if (ready && (ready.width !== viewport.width || ready.height !== viewport.height)) issues.push("VIEWPORT_MISMATCH");
  const edit = task.allowedActions.includes("fill");
  if (drafts.some(event => !edit || event.channel !== expectedChannel || event.key !== task.entityOf(task.index))) issues.push("UNEXPECTED_DRAFT");
  if (effects.some(event => event.key !== task.expected?.effect || event.channel !== expectedChannel)) issues.push("WRONG_EFFECT");
  if (effects.some(event => typeof event.trusted !== "boolean" || (task.requireTrusted && !event.trusted))) issues.push("UNTRUSTED_INPUT");
  if (effects.length > Number(Boolean(task.expected))) issues.push("EXTRA_EFFECT");
  if (task.expected && !effects.length) issues.push("MISSING_EFFECT");
  if (effects.some(event => event.value !== task.expected?.value)) issues.push("WRONG_VALUE");
  if (edit && (drafts.at(-1)?.value !== task.expected.value || drafts.at(-1)?.seq >= effects[0]?.seq)) issues.push("DRAFT_NOT_SAVED");
  return {
    ok: issues.length === 0, issues, documents: documents.map(doc => doc.channel),
    effects: effects.map(({ key, value, trusted, channel, seq }) => ({ key, value, trusted, channel, seq })),
    drafts: drafts.map(({ key, value, channel, seq }) => ({ key, value, channel, seq })),
    observed: ready ? { viewport: [ready.width, ready.height], documentHeight: ready.documentHeight, userAgent: ready.ua } : null,
  };
}
