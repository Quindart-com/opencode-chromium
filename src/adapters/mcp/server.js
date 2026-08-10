#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { z } from "zod";
import { createAgentBrowserRuntime } from "../../core/runtime.js";
import { createCoreRegistry } from "../../core/registry.js";
import { jsonSchemaFor } from "../../core/schema-adapters.js";
import { artifactUriTemplate } from "../../core/artifacts.js";
import { contractMetadata, PLUGIN_NAME, PLUGIN_VERSION } from "../../core/versions.js";
import { createBrowserOperations } from "../../browser/operations/index.js";
import { closeBrowserClients } from "../../browser/client.js";

export const SERVER_NAME = PLUGIN_NAME;
export const SERVER_INSTRUCTIONS = [
  "Use the four browser tools for UI-only work, connector gaps, and visual verification; prefer structured connectors when available.",
  "Pass a user-named profile on the first useful call, batch find/action/settle/verification in browser_run, and reuse sessionId.",
  "Page search uses Snowflake by default; request lexical or auto for lower-latency retrieval, and deep for genuinely semantic, multilingual, or code-heavy matching.",
  "For a specific tab's deeper network debugging, request browser_observe mode capabilities with pack network, then execute network.inspect inside browser_run; bodies are opt-in and approval-gated.",
  "Approval-required results must be followed by browser_run with only the approvalToken. Call browser_finalize when finished.",
].join(" ");

function rootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir(), "package.json"), "utf8")).version ?? PLUGIN_VERSION;
  } catch {
    return PLUGIN_VERSION;
  }
}

export function parseArgs(argv = []) {
  const options = {
    transport: "stdio",
    toolset: "core",
    host: "127.0.0.1",
    port: 3210,
    authTokenEnv: "AGENT_BROWSER_AUTH_TOKEN",
    allowedOrigins: [],
    blockedOrigins: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [rawFlag, inlineValue] = argument.split("=", 2);
    const nextValue = () => inlineValue ?? argv[++index];
    if (rawFlag === "--transport") options.transport = nextValue();
    else if (rawFlag === "--toolset") options.toolset = nextValue();
    else if (rawFlag === "--host") options.host = nextValue();
    else if (rawFlag === "--port") options.port = Number(nextValue());
    else if (rawFlag === "--auth-token-env") options.authTokenEnv = nextValue();
    else if (rawFlag === "--allowed-origin") options.allowedOrigins.push(nextValue());
    else if (rawFlag === "--blocked-origin") options.blockedOrigins.push(nextValue());
    else if (rawFlag === "--help" || rawFlag === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.help && !["stdio", "http"].includes(options.transport)) throw new Error("--transport must be stdio or http");
  if (!options.help && !["core", "legacy", "debug"].includes(options.toolset)) throw new Error("--toolset must be core, legacy, or debug");
  if (!options.help && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error("--port must be between 1 and 65535");
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
    ...contractMetadata(),
  });
}

function mcpSchema(schema) {
  const jsonSchema = jsonSchemaFor(schema);
  return {
    "~standard": {
      version: 1,
      vendor: SERVER_NAME,
      validate(value) {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { value: parsed.data }
          : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

export async function registerCoreTools(server, runtime, fallbackSessionId) {
  const registry = createCoreRegistry(runtime);
  for (const [name, definition] of Object.entries(registry)) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: mcpSchema(definition.inputSchema),
      outputSchema: mcpSchema(definition.outputSchema),
      annotations: definition.annotations,
    }, async (args) => {
      try {
        const parsed = definition.inputSchema.parse(args ?? {});
        const result = definition.outputSchema.parse(await definition.execute(parsed, { sessionID: fallbackSessionId, sessionId: fallbackSessionId, agent: "mcp" }));
        return {
          content: [{ type: "text", text: conciseText(result) }],
          structuredContent: result,
          isError: result.ok === false && result.status !== "approval_required",
        };
      } catch (error) {
        const result = { ...contractMetadata(), ok: false, status: "invalid_request", sessionId: fallbackSessionId, error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error), retryable: false, uncertain: false } };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
  }

  server.registerResource(
    "browser-artifact",
    new ResourceTemplate(artifactUriTemplate(), { list: undefined }),
    { title: "Browser result artifact", description: "Ephemeral large result or screenshot produced by the browser runtime." },
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

export async function registerLegacyTools(server, fallbackSessionId) {
  const hooks = await createBrowserOperations();
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    if (definition.capabilityOnly === true) continue;
    server.registerTool(name, {
      description: `[Compatibility] ${definition.description}`,
      inputSchema: z.object(definition.args),
    }, async (args) => {
      try {
        const text = await definition.execute(args, { sessionID: fallbackSessionId, sessionId: fallbackSessionId, agent: "mcp-compatibility" });
        return { content: [{ type: "text", text: text ?? "" }], isError: false };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
  }
}

export async function createServer({ runtime, toolset = "core", fallbackSessionId = `mcp-${randomUUID()}` } = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: packageVersion() }, { instructions: SERVER_INSTRUCTIONS });
  if (toolset === "core" || toolset === "debug") await registerCoreTools(server, runtime ?? createAgentBrowserRuntime(), fallbackSessionId);
  if (toolset === "legacy" || toolset === "debug") await registerLegacyTools(server, fallbackSessionId);
  return server;
}

export async function serveStdio(options, runtime) {
  const fallbackSessionId = process.env.AGENT_BROWSER_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? `mcp-${randomUUID()}`;
  const server = await createServer({ runtime, toolset: options.toolset, fallbackSessionId });
  await server.connect(new StdioServerTransport());
  return server;
}

export async function serveHttp(options, runtime) {
  const loopback = isLoopback(options.host);
  const configuredToken = process.env[options.authTokenEnv];
  if (!loopback && !configuredToken) throw new Error(`Refusing non-loopback MCP binding without a bearer token in ${options.authTokenEnv}`);
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
        response.end(JSON.stringify({ ...contractMetadata(), ok: true, transport: "http", toolset: options.toolset }));
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
  process.stderr.write(`[${SERVER_NAME}] MCP listening on http://${options.host}:${options.port}/mcp\n`);
  return server;
}

export async function startMcpServer(options = parseArgs(process.argv.slice(2)), { runtime = createAgentBrowserRuntime() } = {}) {
  if (options.help) return null;
  if (options.transport === "stdio") return serveStdio(options, runtime);
  return serveHttp(options, runtime);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: opencode-browser-plugin-mcp [--transport=stdio|http] [--toolset=core|legacy|debug] [--host=127.0.0.1] [--port=3210] [--auth-token-env=AGENT_BROWSER_AUTH_TOKEN] [--allowed-origin=PATTERN] [--blocked-origin=PATTERN]\n");
    return;
  }
  const runtime = createAgentBrowserRuntime({
    urlPolicyConfig: {
      allowedOrigins: options.allowedOrigins,
      blockedOrigins: options.blockedOrigins,
    },
  });
  const cleanup = () => {
    runtime.close();
    closeBrowserClients();
  };
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("exit", cleanup);
  await startMcpServer(options, { runtime });
}

const isMainModule = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) await main();
