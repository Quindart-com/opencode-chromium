#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrowserOperations } from "../src/browser/operations/index.js";
import { createAgentBrowserRuntime } from "../src/core/runtime.js";
import { createCoreRegistry } from "../src/core/registry.js";

const ADAPTER_SERVER_NAME = "opencode-browser-plugin";

function adapterDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function collectJsonLines(buffer) {
  const results = [];
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON framing noise
    }
  }
  return results;
}

async function runServer(toolset, { exerciseCore = false } = {}) {
  const serverPath = path.join(adapterDir(), "src", "adapters", "mcp", "server.js");
  if (!fs.existsSync(serverPath)) throw new Error(`Adapter not found: ${serverPath}`);

  const child = spawn(process.execPath, [serverPath, `--toolset=${toolset}`], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  const waitForResponses = async (count, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (collectJsonLines(buffer).filter((m) => m && m.id !== undefined).length < count) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for adapter responses");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return collectJsonLines(buffer);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "adapter-check", version: "1.0.0" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "ping" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  if (exerciseCore) {
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "browser_run", arguments: { sessionId: "mcp-check", steps: [{ action: "press", key: "Enter" }] } },
    });
  }

  const messages = await waitForResponses(exerciseCore ? 4 : 3);
  child.stdin.end();

  await new Promise((resolve) => {
    child.once("close", resolve);
    setTimeout(() => child.kill(), 5000);
  });

  const byId = new Map(messages.filter((m) => m && m.id !== undefined).map((m) => [m.id, m]));

  const init = byId.get(1);
  if (init?.error) throw new Error(`initialize failed: ${init.error.message}`);
  if (!init?.result?.serverInfo?.name) throw new Error("initialize did not return serverInfo");
  if (init.result.serverInfo.name !== ADAPTER_SERVER_NAME) {
    throw new Error(`initialize returned the wrong server name: ${init.result.serverInfo.name}`);
  }

  const ping = byId.get(2);
  if (ping?.error) throw new Error(`ping failed: ${ping.error.message}`);
  if (!ping?.result || ping.result.isError === true) throw new Error("ping did not return a result");

  const list = byId.get(3);
  if (list?.error) throw new Error(`tools/list failed: ${list.error.message}`);
  const tools = list?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list did not return a tools array");

  if (exerciseCore) {
    const call = byId.get(4);
    if (call?.error) throw new Error(`core tools/call failed: ${call.error.message}`);
    if (call?.result?.structuredContent?.status !== "approval_required") {
      throw new Error("core tools/call did not return structured approval_required output");
    }
  }

  return tools;
}

try {
  const runtime = createAgentBrowserRuntime();
  const coreExpected = Object.keys(createCoreRegistry(runtime));
  runtime.close();
  const hooks = await createBrowserOperations();
  const legacyExpected = Object.keys(hooks?.tool ?? {});
  if (legacyExpected.length === 0) throw new Error("Shared plugin exposed no legacy tools");

  const tools = await runServer("core", { exerciseCore: true });

  const listed = new Map(tools.map((tool) => [tool.name, tool]));
  const missing = coreExpected.filter((name) => !listed.has(name));
  const extra = [...listed.keys()].filter((name) => !coreExpected.includes(name));
  if (missing.length > 0) throw new Error(`Adapter is missing tools: ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`Adapter exposes unexpected tools: ${extra.join(", ")}`);

  let schemaErrors = 0;
  for (const tool of tools) {
    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new Error(`${tool.name} is missing a description`);
    }
    if (!tool.inputSchema || tool.inputSchema.type !== "object" || typeof tool.inputSchema.properties !== "object") {
      console.error(`  ! ${tool.name} has an invalid inputSchema`);
      schemaErrors += 1;
      continue;
    }
  }
  if (schemaErrors > 0) throw new Error("One or more tools produced an invalid MCP input schema");

  const schemaBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  if (schemaBytes > 10000) throw new Error(`Core tool definitions exceed the 10000-byte context budget: ${schemaBytes}`);

  const legacyTools = await runServer("legacy");
  const legacyNames = new Set(legacyTools.map((tool) => tool.name));
  const legacyMissing = legacyExpected.filter((name) => !legacyNames.has(name));
  if (legacyMissing.length > 0) throw new Error(`Legacy MCP mode is missing tools: ${legacyMissing.join(", ")}`);

  console.log(JSON.stringify({ ok: true, coreTools: tools.length, legacyTools: legacyTools.length, schemaBytes }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
