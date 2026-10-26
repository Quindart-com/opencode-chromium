// Synthetic MCP worker: no browser, profile, network, or user data access.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
const { createParticipant } = await import(pathToFileURL(process.env.TEST_PARTICIPANTS_MODULE).href);
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(process.argv[1]), "../../../package.json"), "utf8"));
const activity = createParticipant(process.env.OPENCODE_BROWSER_RUNTIME_DIR, "runtime", pkg.version);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const sessions = new Set();
const cancelled = new Set();
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (method === "notifications/cancelled") { cancelled.add(params.requestId); return reply(params.requestId, { structuredContent: { cancelled: true } }); }
  if (id === undefined) return;
  if (method === "initialize") {
    if (pkg.testInitDelay) await new Promise(resolve => setTimeout(resolve, pkg.testInitDelay));
    return reply(id, { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: pkg.version }, capabilities: { tools: {}, resources: {} } });
  }
  if (method === "tools/list") return reply(id, { tools: [{ name: "browser_session", inputSchema: { type: pkg.testSchema ?? "object" } }] });
  if (method === "resources/templates/list") return reply(id, { resourceTemplates: [] });
  await activity.enter();
  try {
    if (method === "resources/read") return reply(id, { contents: [{ uri: params.uri, mimeType: "image/png", blob: "aW1hZ2U=" }] });
    const args = params.arguments ?? {}, sessionId = args.sessionId ?? process.env.AGENT_BROWSER_SESSION_ID;
    if (args.action === "open") sessions.add(sessionId);
    if (args.action === "finish") sessions.delete(sessionId);
    if (args.action === "crash") process.exit(3);
    if (args.action === "hold") await new Promise(resolve => setTimeout(resolve, 150));
    if (cancelled.has(id)) return;
    if (args.action === "mutation") fs.appendFileSync(process.env.TEST_MUTATION_LOG, "once\n");
    if (args.action === "mutationCrash") { fs.appendFileSync(process.env.TEST_MUTATION_LOG, "once\n"); process.exit(3); }
    reply(id, { content: [{ type: "text", text: JSON.stringify({ version: pkg.version, sessionId, args }) }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], structuredContent: { version: pkg.version, sessionId, args } });
  } finally { activity.leave({ sessions: [...sessions] }); }
});
