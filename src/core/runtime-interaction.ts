import { nodeFrameId } from "../browser/operations/page-state.ts";
import { runRecoveryDoctor } from "../browser/recovery.ts";
import { record } from "../shared/values.ts";
import { errorDetails } from "./failure-context.ts";
import { fitInlinePreview,summarizeNetworkEvents } from './observation-projection.ts';
import type { ObserveInput,Step } from "./registry.ts";
import { RuntimeFoundation,clamp,usesLongSearchTimeout,type PriorResults,type ResolvedTarget,type ResultPayload,type ScreenshotOptions } from "./runtime-foundation.ts";
import type { RuntimeSession } from "./runtime-types.ts";
import { settleBrowserStep } from "./settling.ts";
import { responseMetadata as contractMetadata } from "./versions.ts";

export class RuntimeInteraction extends RuntimeFoundation {
  async editTarget(target: ResolvedTarget, tabId: number, mode: string, value: string | undefined, sessionId: string, _chainId: string | null = null, _stepIndex: number | null = null) {
    if (target.nodeId) return this.invoke("browser_dom_type", ({ tabId, nodeId: target.nodeId, text: value, mode }), sessionId);
    if (target.selector) return this.invoke("browser_locator_fill", ({ tabId, selector: target.selector, value, mode }), sessionId);
    throw new Error("Editable target needs nodeId, selector, or query");
  }

  async clickTarget(toolName: string, target: ResolvedTarget, tabId: number, step: Step, sessionId: string, _chainId: string | null = null, _stepIndex: number | null = null) {
    if (target.nodeId) {
      if (toolName === "browser_double_click") throw new Error("doubleClick requires selector or coordinates");
      return this.invoke("browser_dom_click", ({ tabId, nodeId: target.nodeId }), sessionId);
    }
    if (target.selector) {
      if (toolName === "browser_double_click") throw new Error("doubleClick by selector is not supported; use coordinates");
      return this.invoke("browser_locator_click", ({ tabId, selector: target.selector }), sessionId);
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return this.invoke(toolName, ({ tabId, x: target.x, y: target.y, button: step.button ?? "left" }), sessionId);
    }
    throw new Error(`${step.action} target needs nodeId, selector, query, or coordinates`);
  }

  async hoverTarget(target: ResolvedTarget, tabId: number, sessionId: string, _chainId: string | null = null, _stepIndex: number | null = null) {
    if (target.nodeId) return this.invoke("browser_hover", ({ tabId, nodeId: target.nodeId }), sessionId);
    if (target.selector) return this.invoke("browser_hover", ({ tabId, selector: target.selector }), sessionId);
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return this.invoke("browser_hover", ({ tabId, x: target.x, y: target.y }), sessionId);
    }
    throw new Error("hover target needs nodeId, selector, query, or coordinates");
  }

  async assertTarget(target: ResolvedTarget, tabId: number, step: Step, sessionId: string, _chainId: string | null = null, _stepIndex: number | null = null) {
    const condition = step.condition ?? "exists";
    if (!target.selector && target.nodeId && condition === "exists") {
      await this.invoke("browser_page_inspect", ({ tabId, nodeId: target.nodeId }), sessionId);
      return { passed: true, condition, nodeId: target.nodeId };
    }
    if (!target.selector) throw new Error("assert requires target.selector, or nodeId for an exists check");
    if (condition === "exists" || condition === "not-exists") {
      const { count } = await this.invoke("browser_locator_count", ({ tabId, selector: target.selector }), sessionId);
      const passed = condition === "exists" ? count > 0 : count === 0;
      if (!passed) throw new Error(`Assertion failed: ${target.selector} ${condition}`);
      return { passed, condition, count };
    }
    const { text } = await this.invoke("browser_locator_text", ({ tabId, selector: target.selector }), sessionId);
    const expected = step.value ?? "";
    const passed = condition === "equals" ? text === expected : text.includes(expected);
    if (!passed) throw new Error(`Assertion failed: text ${condition} ${JSON.stringify(expected)}`);
    return { passed, condition, text };
  }

  async settleStep(step: Step, tabId: number, prior: PriorResults, session: RuntimeSession) {
    return settleBrowserStep(this, step, tabId, prior, session);
  }

  async observeValue(args: ObserveInput, tabId: number, session: RuntimeSession) {
    return this.operationScope.run({ frameId: args.target?.frameId ?? nodeFrameId(args.target?.nodeId) }, () => this.observeInScope(args, tabId, session));
  }

  async observeInScope(args: ObserveInput, tabId: number, session: RuntimeSession) {
    const limit = clamp(args.limit, args.mode === "visual" ? 25 : 12, 1, 200);
    const target = args.target ?? {};
    if (args.mode === "capabilities") return (await this.capabilities()).manifest(args.pack ?? "core");
    if (args.mode === "artifact") {
      const artifact = this.artifacts.read(args.uri ?? "", { sessionId: session.sessionId });
      if (!artifact) throw new Error("Artifact expired, missing, or belongs to another browser session.");
      const { data, ...metadata } = artifact;
      return { ...metadata, ...(args.delivery === "inline" ? { base64: data.toString("base64") } : { preview: data.toString("utf8").slice(0, 4096) }) };
    }
    if (args.mode === "search") {
      const prefs = await this.searchPreferences(session);
      return this.invoke("browser_page_search", {
        tabId,
        query: args.query ?? target.query ?? "",
        maxResults: limit,
        detail: args.detail ?? prefs.detail,
        mode: args.searchStrategy ?? prefs.mode,
        timeoutMs: usesLongSearchTimeout(args.searchStrategy ?? prefs.mode) ? 120000 : 10000,
      }, session.sessionId);
    }
    if (args.mode === "inspect") {
      if (target.requestId) {
        return this.invoke("browser_network_inspect", {
          tabId,
          requestId: target.requestId,
          includeBody: "none",
          limit: 1,
        }, session.sessionId);
      }
      return this.invoke("browser_page_inspect", {
        tabId,
        nodeId: target.nodeId,
        selector: target.selector,
        depth: args.detail === "full" || args.detail === "debug" ? 2 : 1,
        maxChildren: limit,
        maxText: args.detail === "full" || args.detail === "debug" ? 700 : 280,
        detail: args.detail ?? "lean",
      }, session.sessionId);
    }
    if (args.mode === "visual") return this.invoke("browser_visual_map", {
      tabId,
      query: args.query ?? target.query,
      selector: target.selector,
      nodeId: target.nodeId,
      maxResults: limit,
      detail: args.detail === "debug" ? "debug" : "lean",
    }, session.sessionId);
    if (args.mode === "extract") {
      const prefs = await this.searchPreferences(session);
      return target.selector
        ? this.invoke("browser_locator_text", { tabId, selector: target.selector }, session.sessionId)
        : this.invoke("browser_page_search", { tabId, query: args.query ?? target.query ?? "main content", maxResults: limit, detail: args.detail ?? prefs.detail, mode: args.searchStrategy ?? prefs.mode, timeoutMs: usesLongSearchTimeout(args.searchStrategy ?? prefs.mode) ? 120000 : 10000 }, session.sessionId);
    }
    if (args.mode === "events") return {
      console: await this.invoke("browser_console_logs", { tabId, limit: clamp(args.limit, 50, 1, 200), raw: false, includeStack: false }, session.sessionId),
      network: summarizeNetworkEvents(await this.invoke("browser_network_events", { tabId, limit: clamp(args.limit, 50, 1, 200) }, session.sessionId), clamp(args.limit, 30, 1, 200)),
      dialogs: await this.invoke("browser_dialog_events", { tabId, limit: clamp(args.limit, 20, 1, 100) }, session.sessionId),
    };
    if (args.mode === "diagnostic") return this.diagnostic(args, tabId, session);
    if (args.mode === "downloads") return this.invoke("browser_download_events", { tabId, limit: clamp(args.limit, 100, 1, 200) }, session.sessionId);
    if (args.mode === "screenshot") return this.screenshot(tabId, args, session.sessionId);
    if (args.mode === "raw-snapshot") return this.invoke("browser_snapshot", { tabId }, session.sessionId);
    throw new Error(`Unsupported observation mode: ${args.mode}`);
  }

  async diagnostic(args: Pick<ObserveInput, "diagnostic">, tabId: number, session: RuntimeSession) {
    const diagnostic = args.diagnostic;
    if (!diagnostic) throw new Error("Diagnostic configuration is required");
    if (diagnostic.type !== "performance") {
      throw new Error(`Unsupported diagnostic type: ${diagnostic.type}`);
    }
    if (diagnostic.action === "record") {
      const recorded = await this.invoke("browser_trace_record", {
        tabId,
        reload: diagnostic.reload ?? true,
        waitUntil: diagnostic.waitUntil ?? "load",
        ...(diagnostic.durationMs !== undefined ? { durationMs: diagnostic.durationMs } : {}),
        ...(diagnostic.timeoutMs !== undefined ? { timeoutMs: diagnostic.timeoutMs } : {}),
      }, session.sessionId);
      if (recorded && typeof recorded.trace === "string") {
        const artifact = this.artifacts.create({
          sessionId: session.sessionId,
          mimeType: "application/json",
          data: recorded.trace,
          label: "performance-trace",
        });
        const { trace: _trace, ...rest } = recorded;
        return { ...rest, traceArtifact: artifact.uri, traceEventCount: recorded.traceEventCount };
      }
      return recorded;
    }
    if (diagnostic.action === "inspect") {
      const artifact = this.artifacts.read(diagnostic.artifact ?? "", { sessionId: session.sessionId });
      if (!artifact) throw new Error("Artifact expired, missing, or belongs to another browser session.");
      return this.invoke("browser_trace_analyze", {
        trace: artifact.data.toString("utf8"),
        ...(diagnostic.url ? { url: diagnostic.url } : {}),
        ...(diagnostic.insight ? { insight: diagnostic.insight } : {}),
      }, session.sessionId);
    }
    throw new Error(`Unsupported performance action: ${diagnostic.action}`);
  }

  async screenshot(tabId: number, options: ScreenshotOptions, sessionId: string, _chainId: string | null = null, _stepIndex: number | null = null) {
    const shot = await this.invoke("browser_screenshot", {
      tabId,
      fullPage: options.fullPage ?? false,
      format: options.format ?? "png",
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      timeoutMs: options.timeoutMs ?? 30000,
    }, sessionId);
    if (options.delivery === "inline") return shot;
    const artifact = this.artifacts.create({ sessionId, mimeType: shot.mimeType, data: Buffer.from(shot.base64, "base64"), label: "screenshot" });
    const { base64: _base64, ...capture } = shot;
    return { screenshot: artifact, capture };
  }

  compact(payload: ResultPayload, sessionId: string, maxChars: number = 4096, label: string = "result", inlinePayload: ResultPayload = payload) {
    const versionedPayload = { ...contractMetadata(), ...payload };
    const serialized = JSON.stringify(versionedPayload);
    if (serialized.length <= maxChars) return versionedPayload;
    const artifact = this.artifacts.create({ sessionId, mimeType: "application/json", data: versionedPayload, label });
    const preview = fitInlinePreview(inlinePayload, Math.max(256, maxChars - 700));
    return {
      ...contractMetadata(),
      ...record(preview),
      ok: versionedPayload.ok,
      status: versionedPayload.status,
      sessionId,
      ...(record(payload).authorization ? { authorization: record(payload).authorization } : {}),
      truncated: true,
      summary: versionedPayload.summary ?? `${label} was truncated to a useful inline preview; the complete result is optional at artifact.uri`,
      artifact,
    };
  }

  async failure(sessionId: string, error: unknown, extra: Record<string, unknown> = {}) {
    const fields = record(error);
    if (!fields.recovery && ["BROWSER_HOST_UNRESPONSIVE", "BROWSER_HOST_ACCESS_DENIED"].includes(String(fields.code)) && process.env.OPENCODE_BROWSER_SKIP_RECOVERY !== "1") {
      const recovery = await runRecoveryDoctor(this.sessions.get(sessionId)?.profileId);
      Object.assign(error instanceof Error ? error : {}, { recovery });
    }
    const detail = errorDetails(error);
    return {
      ...contractMetadata(),
      ok: false,
      status: detail.code.toLocaleLowerCase(),
      sessionId,
      error: detail,
      ...(record(error).profiles ? { profiles: record(error).profiles } : {}),
      ...extra,
    };
  }
}
