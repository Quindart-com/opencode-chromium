#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { z } from "zod";
import { createAgentBrowserRuntime } from "../browser-core/runtime.js";
import { createCoreRegistry } from "../browser-core/registry.js";
import { artifactUriTemplate } from "../browser-core/artifacts.js";
import { ChromiumBrowserPlugin } from "../opencode-plugin/src/plugin.js";
import { closeBrowserClients } from "../opencode-plugin/src/client.js";

const SERVER_NAME = "opencode-browser-adapter";
const SERVER_INSTRUCTIONS = [
  "Prefer native connectors or APIs for structured Airtable, Stripe, Gmail, Calendar, and similar work; use the browser for UI-only settings, unavailable connector features, and visual verification.",
  "When the user names a browser profile, pass it on the first useful call. Do not make status or profile-selection-only round trips.",
  "Combine find, action, conditional settle, and verification/postObserve in one browser_run. Never add fixed-delay wait steps.",
  "Use browser_observe only for new evidence. Search is lexical-first; use deep only when explicitly justified.",
  "Do not use raw Node or another browser integration when these browser tools are available.",
  "Reuse sessionId and call browser_finalize when done. For approval_required, send browser_run with only approvalToken.",
].join(" ");

function rootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir(), "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv) {
  const options = { transport: "stdio", toolset: "core", host: "127.0.0.1", port: 3210, authTokenEnv: "AGENT_BROWSER_AUTH_TOKEN" };
  for (const argument of argv) {
    const [flag, value] = argument.split("=", 2);
    if (flag === "--transport") options.transport = value;
    else if (flag === "--toolset") options.toolset = value;
    else if (flag === "--host") options.host = value;
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--auth-token-env") options.authTokenEnv = value;
    else if (flag === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!["stdio", "http"].includes(options.transport)) throw new Error("--transport must be stdio or http");
  if (!["core", "legacy", "debug"].includes(options.toolset)) throw new Error("--toolset must be core, legacy, or debug");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be between 1 and 65535");
  return options;
}

function isLoopback(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function equalSecret(first, second) {
  const a = Buffer.from(first ?? "");
  const b = Buffer.from(second ?? "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function conciseText(result) {
  const text = JSON.stringify(result);
  return text.length <= 4000 ? text : JSON.stringify({
    ok: result.ok,
    status: result.status,
    sessionId: result.sessionId,
    summary: result.summary ?? "Full output is available as the returned artifact resource.",
    artifact: result.artifact,
  });
}

async function registerCoreTools(server, runtime, fallbackSessionId) {
  const registry = createCoreRegistry(runtime);
  for (const [name, definition] of Object.entries(registry)) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
    }, async (args) => {
      const result = await definition.execute(args, { sessionID: fallbackSessionId, agent: "mcp" });
      return {
        content: [{ type: "text", text: conciseText(result) }],
        structuredContent: result,
        isError: result.ok === false && result.status !== "approval_required",
      };
    });
  }

  server.registerResource(
    "browser-artifact",
    new ResourceTemplate(artifactUriTemplate(), { list: undefined }),
    { title: "Browser result artifact", description: "Ephemeral large result or screenshot produced by an agent browser tool." },
    async (uri) => {
      const artifact = runtime.artifacts.read(uri.href);
      if (!artifact) throw new Error(`Browser artifact expired or was not found: ${uri.href}`);
      const binary = !artifact.mimeType.startsWith("text/") && artifact.mimeType !== "application/json";
      return {
        contents: [{
          uri: artifact.uri,
          mimeType: artifact.mimeType,
          ...(binary ? { blob: artifact.data.toString("base64") } : { text: artifact.data.toString("utf8") }),
        }],
      };
    },
  );
}

async function registerLegacyTools(server, fallbackSessionId) {
  const hooks = await ChromiumBrowserPlugin();
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    server.registerTool(name, {
      description: `[Legacy compatibility] ${definition.description}`,
      inputSchema: z.object(definition.args),
    }, async (args) => {
      try {
        const text = await definition.execute(args, { sessionID: fallbackSessionId, agent: "mcp-legacy" });
        return { content: [{ type: "text", text: text ?? "" }], isError: false };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
  }
}

async function createServer({ runtime, toolset, fallbackSessionId }) {
  const server = new McpServer({ name: SERVER_NAME, version: packageVersion() }, { instructions: SERVER_INSTRUCTIONS });
  if (toolset === "core" || toolset === "debug") await registerCoreTools(server, runtime, fallbackSessionId);
  if (toolset === "legacy" || toolset === "debug") await registerLegacyTools(server, fallbackSessionId);
  return server;
}

async function serveStdio(options, runtime) {
  const fallbackSessionId = process.env.AGENT_BROWSER_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? `mcp-${randomUUID()}`;
  const server = await createServer({ runtime, toolset: options.toolset, fallbackSessionId });
  await server.connect(new StdioServerTransport());
}

async function serveHttp(options, runtime) {
  const loopback = isLoopback(options.host);
  const configuredToken = process.env[options.authTokenEnv];
  if (!loopback && !configuredToken) {
    throw new Error(`Refusing non-loopback MCP binding without a bearer token in ${options.authTokenEnv}`);
  }
  const validateHost = loopback ? localhostHostValidation() : null;
  const validateOrigin = loopback ? localhostOriginValidation() : null;
  const server = http.createServer(async (request, response) => {
    try {
      if (validateHost && (!validateHost(request, response) || !validateOrigin(request, response))) return;
      if (configuredToken) {
        const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
        if (!equalSecret(configuredToken, supplied)) {
          response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, transport: "http", toolset: options.toolset }));
        return;
      }
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = await createServer({ runtime, toolset: options.toolset, fallbackSessionId: `http-${randomUUID()}` });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
      if (!response.writableEnded) response.once("finish", () => mcp.close().catch(() => {}));
      else await mcp.close();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  process.stderr.write(`OpenCode Browser Adapter MCP listening on http://${options.host}:${options.port}/mcp\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("Usage: node codex-adapter/mcp-server.js [--transport=stdio|http] [--toolset=core|legacy|debug] [--host=127.0.0.1] [--port=3210] [--auth-token-env=AGENT_BROWSER_AUTH_TOKEN]\n");
  process.exit(0);
}

const runtime = createAgentBrowserRuntime();
const cleanup = () => {
  runtime.close();
  closeBrowserClients();
};
process.once("SIGINT", () => { cleanup(); process.exit(0); });
process.once("SIGTERM", () => { cleanup(); process.exit(0); });
process.once("exit", cleanup);

if (options.transport === "stdio") await serveStdio(options, runtime);
else await serveHttp(options, runtime);
