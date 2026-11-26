import http from "node:http";
import { createTelemetryCollector } from "../src/telemetry/collector.ts";

const handle = createTelemetryCollector({ measurementId: process.env.GA4_MEASUREMENT_ID ?? "", apiSecret: process.env.GA4_API_SECRET ?? "" });
const server = http.createServer(async (incoming, outgoing) => {
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 24000) { outgoing.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    // Deliberately omit every incoming forwarding header and all network identity.
    const response = await handle(new Request(`https://collector.invalid${incoming.url ?? "/"}`, {
      method: incoming.method, headers: { "Content-Type": incoming.headers["content-type"] ?? "" },
      ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    }));
    outgoing.writeHead(response.status, { "Cache-Control": "no-store" }).end();
  } catch { outgoing.writeHead(400).end(); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.maxHeadersCount = 20;
server.listen(Number(process.env.PORT ?? 8787), process.env.COLLECTOR_BIND ?? "127.0.0.1");
