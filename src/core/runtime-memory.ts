import { z } from "zod";
import { nodeFrameId } from "../browser/operations/page-state.ts";
import { partialDispatchError } from "../shared/execution-state.ts";
import { record } from "../shared/values.ts";
import { BrowserRuntimeError } from "./errors.ts";
import { errorDetails } from "./failure-context.ts";
import { screenshotResultSchema } from "./operation-results.ts";
import type { RunInput,Step } from "./registry.ts";
import { replayGateRejection } from "./replay-gate.ts";
import { requiresApproval } from './run-validation.ts';
import { READ_ACTIONS,clamp,isStaleTargetError,memoryMatchSchema,parseLegacyResult,rememberedStepMismatch,type MemoryCapture,type PriorResults,type ReplayOutcome,type RunStepResult,type StepExecution,type StepOutcome } from "./runtime-foundation.ts";
import { RuntimeInteraction } from "./runtime-interaction.ts";
import type { RuntimeSession } from "./runtime-types.ts";

export class RuntimeMemory extends RuntimeInteraction {
  async executeStep(step: Step, tabId: number, prior: PriorResults, session: RuntimeSession, chainId: string | null = null, stepIndex: number | null = null) {
    return this.operationScope.run({ frameId: step.target?.frameId ?? nodeFrameId(step.target?.nodeId), deadlineAt: Date.now() + clamp(step.timeoutMs, step.action === "upload" ? 120000 : 15000, 250, 120000) }, () => this.executeStepInScope(step, tabId, prior, session, chainId, stepIndex));
  }

  async executeStepInScope(step: Step, tabId: number, prior: PriorResults, session: RuntimeSession, chainId: string | null, stepIndex: number | null) {
    const timeoutMs = clamp(step.timeoutMs, 15000, 250, 60000);
    if (step.action === "find") {
      const query = step.target?.query ?? step.value ?? "";
      const prefs = await this.searchPreferences(session);
      return this.invoke("browser_page_search", ({ tabId, query, maxResults: prefs.maxResults, detail: prefs.detail, mode: prefs.mode, timeoutMs }), session.sessionId);
    }
    if (step.action === "capability") {
      const registry = await this.capabilities();
      const definition = registry.get(step.capability ?? "");
      if (!definition) {
        const error = new BrowserRuntimeError(`Unknown browser capability: ${step.capability}`, { code: "CAPABILITY_NOT_FOUND" });
        throw error;
      }
      const input = { ...record(step.input), ...(tabId && record(step.input).tabId === undefined ? { tabId } : {}) };
      const parsed = registry.validate(step.capability ?? "", input);
      const value = await definition.execute(parsed, { sessionID: session.sessionId, sessionId: session.sessionId, agent: "agent-browser-core", urlPolicy: this.urlPolicy, filePolicy: this.filePolicy });
      if (step.capability === "network.inspect" && record(parsed).bodyDelivery === "artifact") {
        return this.spillNetworkBodies(typeof value === "string" ? parseLegacyResult(value) : value, session.sessionId);
      }
      return value;
    }
    let target = await this.resolveTarget(step, tabId, prior, session.sessionId);
    const dispatch = async () => {
      switch (step.action) {
        case "navigate": return this.invoke("browser_navigate", ({ tabId, url: step.url, waitUntil: step.waitUntil ?? "domcontentloaded", timeoutMs }), session.sessionId);
        case "reload": return this.invoke("browser_reload", ({ tabId, bypassCache: step.bypassCache ?? false }), session.sessionId);
        case "back": return this.invoke("browser_back", ({ tabId }), session.sessionId);
        case "forward": return this.invoke("browser_forward", ({ tabId }), session.sessionId);
        case "click": return this.clickTarget("browser_click", target, tabId, step, session.sessionId, chainId, stepIndex);
        case "doubleClick": return this.clickTarget("browser_double_click", target, tabId, step, session.sessionId, chainId, stepIndex);
        case "hover": return this.hoverTarget(target, tabId, session.sessionId, chainId, stepIndex);
        case "handleDialog": return this.invoke("browser_handle_dialog", ({ tabId, value: step.value, promptText: step.promptText }), session.sessionId);
        case "focus": return this.editTarget(target, tabId, "focus", "", session.sessionId, chainId, stepIndex);
        case "fill":
        case "replaceText":
        case "select": return this.editTarget(target, tabId, "replace", step.value, session.sessionId, chainId, stepIndex);
        case "fillForm": {
          const fields = [];
          try {
          for (const [selector, value] of Object.entries(step.fields ?? {})) {
            fields.push(await this.invoke("browser_locator_fill", ({ tabId, selector, value, mode: "replace" }), session.sessionId));
          }
          } catch (error) { throw partialDispatchError(error, fields.length); }
          return { filled: fields.length, fields };
        }
        case "type": {
          if (target.nodeId || target.selector) return this.editTarget(target, tabId, "append", step.value, session.sessionId, chainId, stepIndex);
          return this.invoke("browser_type", ({ tabId, text: step.value }), session.sessionId);
        }
        case "press": return this.invoke("browser_keypress", ({ tabId, key: step.key, nodeId: target.nodeId, selector: target.selector, frameId: target.frameId }), session.sessionId);
        case "scroll": return this.invoke("browser_scroll", ({ tabId, x: target.x, y: target.y, scrollX: step.scrollX ?? 0, scrollY: step.scrollY ?? 0 }), session.sessionId);
        case "drag": return this.invoke("browser_drag", ({ tabId, path: step.path, button: step.button ?? "left" }), session.sessionId);
        case "assert": return this.assertTarget(target, tabId, step, session.sessionId, chainId, stepIndex);
        case "upload": return this.invoke("browser_set_file_input", ({ tabId, nodeId: target.nodeId ?? undefined, selector: target.selector, files: step.files }), session.sessionId);
        case "clipboardRead": return this.invoke("browser_clipboard_read_text", ({ tabId }), session.sessionId);
        case "clipboardWrite": return this.invoke("browser_clipboard_write_text", ({ tabId, text: step.value }), session.sessionId);
        case "screenshot": {
          const shot = await this.screenshot(tabId, step, session.sessionId, chainId, stepIndex);
          if (typeof record(shot).base64 === "string") {
            const { base64, ...capture } = screenshotResultSchema.parse(shot);
            const artifact = this.artifacts.create({ sessionId: session.sessionId, mimeType: screenshotResultSchema.parse(shot).mimeType, data: Buffer.from(base64, "base64"), label: "screenshot" });
            return { screenshot: artifact, capture };
          }
          return shot;
        }
        case "close": {
          const result = await this.invoke("browser_close_tab", ({ tabId }), session.sessionId);
          session.configuredTabs?.delete(`${session.profileId}:${tabId}`);
          session.activeTabId = null;
          return result;
        }
        default: throw new Error(`Unsupported action: ${step.action}`);
      }
    };
    try {
      return await this.operationScope.run({ ...this.operationScope.getStore(), frameId: target.frameId ?? nodeFrameId(target.nodeId) ?? this.operationScope.getStore()?.frameId }, dispatch);
    } catch (error) {
      if (record(error).code === "STALE_TARGET") throw error;
      if (errorDetails(error).uncertain || !isStaleTargetError(error) || (!step.target?.selector && !step.target?.query)) throw error;
      target = await this.resolveTarget({ ...step, target: { ...step.target, nodeId: undefined } }, tabId, prior, session.sessionId);
      return this.operationScope.run({ ...this.operationScope.getStore(), frameId: target.frameId ?? nodeFrameId(target.nodeId) ?? this.operationScope.getStore()?.frameId }, dispatch);
    }
  }

  // One cheap probe per run feeds both the replay attempt and the recording
  // gate, so enabling memory costs a single round trip instead of two.
  async memoryCaptureState(session: RuntimeSession) {
    try {
      const state = record(await this.requestHost("memory.captureState", {}, session).catch(() => null));
      if (typeof state.enabled === "boolean") return { enabled: state.enabled, paused: state.paused === true, embedding_profile: typeof state.embedding_profile === "string" ? state.embedding_profile : null };
      const status = record(await this.requestHost("memory.stats", {}, session).catch(() => null));
      if (!status) return null;
      return { enabled: status.enabled === true, paused: status.paused === true, embedding_profile: typeof status.embedding_profile === "string" ? status.embedding_profile : null };
    } catch {
      return null;
    }
  }

  memoryRecordingEnabled(memoryState: MemoryCapture | null) {
    return memoryState?.enabled === true && memoryState?.paused !== true;
  }

  async memoryHostname(step: Step | undefined, tabId: number, session: RuntimeSession) {
    let candidate = step?.action === "navigate" ? step.url : null;
    if (!candidate) {
      try {
        const tab = await this.invoke("browser_get_tab", { tabId }, session.sessionId);
        candidate = tab?.url ?? null;
      } catch {
        return null;
      }
    }
    try {
      const hostname = new URL(candidate ?? "").hostname.toLowerCase() || null;
      return hostname;
    } catch {
      return null;
    }
  }

  // Stage B: attempt a remembered recipe through the ordinary execution path.
  // Remembered steps are parameterized; runtime values and URLs always come
  // from the agent's own request, never from stored memory.
  async tryMemoryReplay(request: RunInput & { steps: Step[] }, session: RuntimeSession, tabId: number, memoryState: MemoryCapture | null = null): Promise<ReplayOutcome> {
    const state = memoryState ?? await this.memoryCaptureState(session);
    if (!this.memoryRecordingEnabled(state)) return null;
    const hostname = await this.memoryHostname(request.steps?.[0], tabId, session);
    // Deterministic recall first: repeating a chain on the same host is an exact
    // recipe match and needs no embedding call. The semantic path stays an
    // explicit, bounded fallback for a caller-supplied transient intent.
    let match;
    try {
      const found = await this.requestHost("memory.recipe", { steps: request.steps, hostname }, session);
      match = memoryMatchSchema.nullable().parse(record(found).match ?? null);
    } catch {
      match = null;
    }
    if (!match && typeof request.memoryIntent === "string" && request.memoryIntent.length > 0) {
      try {
        const selected = await this.requestHost("memory.selectRecipe", { intent: request.memoryIntent, hostname, stepCount: request.steps?.length }, session);
        match = memoryMatchSchema.nullable().parse(record(selected).match ?? null);
      } catch { /* Provider absence keeps ordinary memory recall available. */ }
    }
    if (!match && typeof request.memoryIntent === "string" && request.memoryIntent.length > 0) {
      try {
        const search = await this.requestHost("memory.search", { query: request.memoryIntent, limit: 1, kind: "chain", hostname }, session);
        const rows = record(search).results;
        match = z.array(memoryMatchSchema).parse(Array.isArray(rows) ? rows : []).find(item => item.kind === "chain_v2") ?? null;
      } catch {
        match = null;
      }
    }
    if (!match) return null;
    const rememberedChainId = match.id ?? null;
    const steps = match.steps ?? [];
    if (steps.length === 0) return null;
    const gate = replayGateRejection(match, state ?? undefined);
    if (gate) return this.rejectReplay(gate, rememberedChainId, session);
    if (steps.length !== request.steps?.length) {
      return this.rejectReplay("step_count_mismatch", rememberedChainId, session);
    }
    for (const [index, remembered] of steps.entries()) {
      const mismatch = rememberedStepMismatch(remembered, request.steps?.[index], hostname);
      if (mismatch) return this.rejectReplay(mismatch, rememberedChainId, session);
    }
    const bound = [];
    for (const [index, remembered] of steps.entries()) {
      const source = request.steps[index];
      if (!source) return this.rejectReplay("step_count_mismatch", rememberedChainId, session);
      if (remembered.requiresRuntimeValue && (source?.value === undefined || source?.value === null)) {
        return this.rejectReplay("missing_runtime_value", rememberedChainId, session);
      }
      if (remembered.requiresRuntimeUrl && typeof source?.url !== "string") {
        return this.rejectReplay("missing_runtime_url", rememberedChainId, session);
      }
      bound.push({
        ...source,
        ...(source.id ? { id: source.id } : {}),
        action: source.action,
        target: {
          ...(source.target ?? {}),
          ...(remembered.target_label ? { query: remembered.target_label } : {}),
          ...(remembered.target_role ? { role: remembered.target_role } : {}),
          ...(remembered.selector ? { selector: remembered.selector } : {}),
        },
        ...(remembered.requiresRuntimeValue ? { value: source.value } : {}),
        ...(remembered.requiresRuntimeUrl ? { url: source.url } : {}),
        ...(source?.waitUntil ? { waitUntil: source.waitUntil } : {}),
        ...(source?.settle ? { settle: source.settle } : {}),
      });
    }
    // Approval is re-evaluated on the bound steps: a remembered recipe can never
    // turn a gated request into an ungated one.
    if (requiresApproval(bound).length > 0) {
      return this.rejectReplay("approval_required", rememberedChainId, session);
    }
    await this.requestHost("memory.usageEvent", { eventType: "replay_started", chainId: rememberedChainId, stepsReused: bound.length }, session).catch(() => {});
    const replayChainId = `${session.sessionId}:replay:${this.memoryChainSequence++}`;
    const prior: PriorResults = new Map();
    const results: RunStepResult[] = [];
    let allOk = true;
    let completedMutation = false;
    let uncertainMutation = false;
    for (const [index, step] of bound.entries()) {
      const outcome = await this.executeStepWithPolicy({ step, index, tabId, prior, session, chainId: replayChainId, memoryEnabled: true });
      if (outcome.ok) {
        if (record(outcome.settled).settled === false) allOk = false;
        if (!READ_ACTIONS.has(step.action)) completedMutation = true;
        results.push({ index, action: step.action, ok: true, ...(outcome.settled ? { settle: outcome.settled } : {}) });
      } else {
        allOk = false;
        const detail = outcome.error;
        uncertainMutation = !READ_ACTIONS.has(step.action) && detail.uncertain === true;
        results.push({ index, action: step.action, ok: false, error: detail });
        break;
      }
    }
    await this.requestHost("memory.finalizeChain", { chainId: replayChainId, success: allOk, supersedes: allOk ? rememberedChainId : null }, session).catch(() => {});
    if (!allOk) {
      await this.requestHost("memory.usageEvent", { eventType: "replay_failed", chainId: rememberedChainId, success: false, stepsReused: results.filter((item) => item.ok).length, reason: "stale_step" }, session).catch(() => {});
      if (completedMutation || uncertainMutation) {
        return { used: true, stepsReused: results.filter((item) => item.ok).length, results, failed: true };
      }
      return { fallback: true, supersedes: rememberedChainId };
    }
    await this.requestHost("memory.usageEvent", { eventType: "replay_succeeded", chainId: rememberedChainId, success: true, stepsReused: results.length }, session).catch(() => {});
    return { used: true, stepsReused: results.length, results };
  }

  // Report a skipped replay with a reason precise enough to diagnose, and fall
  // back to normal exploration. Rejections are best-effort telemetry: they can
  // never fail the caller's action chain.
  async rejectReplay(reason: string, chainId: string | number | null, session: RuntimeSession) {
    await this.requestHost("memory.usageEvent", { eventType: "replay_rejected", chainId, reason }, session).catch(() => {});
    return { used: false as const, fallback: true as const };
  }

  // One high-level browser step produces exactly one memory record, whatever
  // the step expands to at the RPC layer. Only privacy-safe fields persist.
  async recordMemoryStep({ chainId, position, step, tabId, success, durationMs, errorCode }: { chainId: string | null; position: number; step: Step; tabId: number; success: boolean; durationMs: number; errorCode: string | null }, session: RuntimeSession) {
    const target = step.target ?? {};
    const summary = {
      action: step.action,
      target: {
        label: target.query ?? record(target).label ?? null,
        role: target.role ?? null,
        selector: target.query ? null : target.selector ?? null,
      },
    };
    const hostname = await this.memoryHostname(step, tabId, session);
    await this.requestHost("memory.recordStep", {
      chainId,
      position,
      action: summary.action,
      tabId,
      hostname,
      target: summary.target,
      success: success === true,
      durationMs,
      errorCode,
    }, session);
  }

  async executeStepWithPolicy({ step, index, tabId, prior, session, chainId, memoryEnabled }: StepExecution): Promise<StepOutcome> {
    const startedAt = Date.now();
    const attempts = READ_ACTIONS.has(step.action) ? (step.retry ?? 0) + 1 : 1;
    let value;
    let lastError = null;
    let settled = null;
    let executionState = "not_started";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        value = await this.executeStep(step, tabId, prior, session, chainId, index);
        executionState = "completed";
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        executionState = READ_ACTIONS.has(step.action) || record(error).executionState === "not_started" ? "not_started" : "unknown";
        if (record(error).retryable === false) break;
      }
    }
    if (!lastError) {
      try {
        settled = await this.settleStep(step, tabId, prior, session);
      } catch (error) {
        if (step.settle) lastError = error;
        else settled = { settled: false, degraded: true, error: errorDetails(error) };
      }
    }
    if (!lastError && step.id) prior.set(step.id, value);
    if (memoryEnabled) {
      await this.recordMemoryStep({
        chainId,
        position: index,
        step,
        tabId,
        success: lastError == null && record(settled).settled !== false,
        durationMs: Date.now() - startedAt,
        errorCode: lastError ? errorDetails(lastError).code ?? "unknown" : record(settled).settled === false ? "SETTLE_UNVERIFIED" : null,
      }, session).catch(() => {});
    }
    return lastError
      ? { ok: false, executionState, error: { ...errorDetails(lastError), uncertain: executionState === "unknown" || errorDetails(lastError).uncertain }, rawError: lastError, value, settled }
      : { ok: true, executionState, value, settled };
  }
}
