import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export function failure(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, ...detail });
}

export function errorRecord(error, phase) {
  const code = error?.name === "TimeoutError" ? "TIMEOUT" : typeof error?.code === "string" ? error.code : "HARNESS_ERROR";
  return { phase, code, message: String(error?.cause?.message ?? error?.message ?? error).replace(/\s+/g, " ").slice(0, 450), ...(error?.approval ? { approval: "requested" } : {}) };
}

const textOf = content => (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");

export function createMeter(encode) {
  const pending = new WeakMap();
  return {
    record(row, params, text) { pending.set(row, [JSON.stringify(params ?? {}), text]); },
    measure(rows) {
      for (const row of rows) {
        const input = pending.get(row);
        if (!input) continue;
        const [request, response] = input;
        row.requestTokens = encode ? encode(request) : null;
        row.responseTextTokens = encode ? encode(response) : null;
        pending.delete(row);
      }
    },
  };
}

export function openStdio({ entry, args = [], cwd, env, deadlineMs, meter }) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let id = 0, ended, stderr = "";
  const closed = new Promise(resolve => child.once("close", resolve));
  const end = error => {
    if (ended) return;
    ended = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", error => end(failure("MCP_SPAWN", error.message)));
  child.on("exit", (code, signal) => end(failure("MCP_EXIT", `MCP process exited (${code ?? signal}). ${stderr}`)));
  child.stdin.on("error", error => end(failure("MCP_PIPE", error.message)));
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-800); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let reply;
    try { reply = JSON.parse(line); }
    catch { end(failure("MCP_PROTOCOL", "MCP stdout contained a non-JSON line")); return; }
    if (reply.method && reply.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: reply.id, error: { code: -32601, message: "Benchmark client has no server-initiated tools" } })}\n`);
      return;
    }
    pending.get(reply.id)?.resolve({ reply, bytes: Buffer.byteLength(line) + 1 });
  });

  async function request(calls, phase, method, params, { mutating = false, expectedRejection = false, allowApproval = false, grantedApproval = false } = {}) {
    const requestId = ++id;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`;
    const row = { phase, method, tool: params?.name ?? null, startedAt: new Date().toISOString(), deadlineMs,
      requestWireBytes: 0, responseWireBytes: 0, responseTextBytes: 0, imageBlocks: 0,
      outcome: "failed", code: null, execution: mutating ? "not_started" : null, expectedRejection };
    calls.push(row);
    let timer, resultText = "";
    const started = performance.now();
    try {
      if (ended) throw ended;
      const { reply, bytes } = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(failure("TIMEOUT", `${method} exceeded ${deadlineMs} ms`)), deadlineMs);
        pending.set(requestId, { resolve, reject });
        row.requestWireBytes = Buffer.byteLength(payload);
        if (mutating) row.execution = "unknown";
        child.stdin.write(payload);
      });
      row.responseWireBytes = bytes;
      if (reply.error) {
        resultText = JSON.stringify(reply.error);
        throw failure("MCP_RPC_ERROR", String(reply.error.message ?? "MCP RPC failed"));
      }
      const result = reply.result;
      if (!result) throw failure("MCP_PROTOCOL", "MCP reply contained no result");
      resultText = result.content ? textOf(result.content) : result.contents ? textOf(result.contents.map(block => ({ ...block, type: "text" }))) : JSON.stringify(result.tools ?? result);
      row.imageBlocks = result.content?.filter(block => block.type === "image").length ?? 0;
      const value = result.structuredContent;
      const stepError = value?.results?.find(step => step.error)?.error;
      const observeError = value?.observation?.error;
      const detail = value?.error ?? stepError ?? observeError;
      const approval = value?.authorization?.required === true || detail?.authorization?.required === true || /approval_required|authorization_required/.test(value?.status ?? "");
      row.approval = approval ? "requested" : grantedApproval ? "granted" : null;
      row.productStatus = value?.status ?? null;
      if (mutating) {
        if (value?.ok === true || value?.results?.some(step => step.ok && ["click", "fill"].includes(step.action))) row.execution = "acknowledged";
        else if (detail?.executionState === "not_started" || approval) row.execution = "not_started";
        else if (!result.isError && !value) row.execution = "acknowledged";
      }
      if (allowApproval && approval && value?.status === "approval_required") {
        row.outcome = "approval_required";
        row.code = "APPROVAL_REQUIRED";
        return { result, text: resultText };
      }
      if (result.isError || value?.ok === false || approval) {
        const code = detail?.code ?? (approval ? "APPROVAL_REQUIRED" : "TOOL_ERROR");
        const failurePhase = observeError && !stepError ? phase === "navigate" ? "lookup" : "confirmation" : phase;
        throw failure(code, detail?.message ?? (resultText || "Tool call failed"), { approval, phase: failurePhase });
      }
      row.outcome = "ok";
      return { result, text: resultText };
    } catch (error) {
      row.code = error.code ?? "MCP_ERROR";
      row.failurePhase = error.phase ?? phase;
      throw error;
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
      row.ms = performance.now() - started;
      row.responseTextBytes = Buffer.byteLength(resultText);
      if (row.requestWireBytes || row.responseWireBytes) meter.record(row, params, resultText);
    }
  }

  async function initialize(calls) {
    const { result } = await request(calls, "initialize", "initialize", { protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "verified-browser-benchmark", version: "1" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const { result: list } = await request(calls, "schema", "tools/list", {});
    return { server: result.serverInfo, protocol: result.protocolVersion, tools: list.tools.length };
  }

  return {
    request, initialize,
    async close() {
      child.stdin.end();
      const clean = await Promise.race([closed.then(() => true), delay(1000, false, { ref: false })]);
      if (!clean) { child.kill(); await Promise.race([closed, delay(3000)]); }
      lines.close();
    },
  };
}
