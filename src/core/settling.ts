import { createHash } from "node:crypto";
import { nodeFrameId } from "../browser/operations/page-state.ts";
import { record } from "../shared/values.ts";
import { stopsBrowserChain } from "./failure-context.ts";
import { BrowserRuntimeError } from "./errors.ts";
import type { Step } from "./registry.ts";
import type { RuntimePort } from "./runtime-port.ts";
import type { RuntimeSession } from "./runtime-types.ts";

const automatic = new Set(["navigate", "reload", "back", "forward", "click", "doubleClick"]);
const DOM_QUIET_MS = 500;
export async function settleBrowserStep(runtime: RuntimePort, step: Step, tabId: number, prior: Map<string, unknown>, session: RuntimeSession) {
  const spec = step.settle ?? (automatic.has(step.action) ? { condition: "dom-quiet" as const } : null);
  if (!spec) return null;
  const timeoutMs = Math.max(100, Math.min(spec.timeoutMs ?? 2500, 15000));
  const target = await runtime.resolveTarget({ target: spec.target ?? step.target }, tabId, prior, session.sessionId);
  const started = Date.now(), deadlineAt = started + timeoutMs;
  return runtime.operationScope.run({ frameId: target.frameId ?? nodeFrameId(target.nodeId), deadlineAt }, async () => {
    let signature = "", changedAt = started, cheap = true, observedChanges = 0;
    do {
      let passed: boolean;
      let pollAfterMs = 100;
      if (spec.condition === "dom-quiet") {
        // The page already tracks the age of its last relevant DOM mutation, so one tiny probe replaces a
        // full snapshot per poll. Hosts without the probe fall back to the snapshot comparison.
        const quiet = cheap ? record(await runtime.invoke("browser_dom_quiet", { tabId }, session.sessionId).catch(error => { if (stopsBrowserChain(error)) throw error; return null; })) : null;
        const age = quiet?.lastMutationAgeMs;
        if (quiet && typeof age === "number" && Number.isFinite(age) && age >= 0) {
          const now = Date.now();
          const current = `${String(quiet.documentId)}:${String(quiet.revision)}`;
          // The probe already observed mutations between calls. Use its age to
          // avoid polling before a quiet window could finish.
          if (current !== signature) {
            if (signature) observedChanges++;
            signature = current;
            changedAt = Math.max(started, now - age);
          }
          // Live tickers can change indefinitely. End the implicit wait with an explicit
          // unsettled result. An explicitly requested quiet window keeps its full budget.
          if (!step.settle && observedChanges >= 2 && now - started >= 1000 && age < DOM_QUIET_MS)
            return { condition: spec.condition, settled: false, reason: "page_still_changing" };
          const remaining = DOM_QUIET_MS - Math.min(now - changedAt, age);
          passed = remaining <= 0;
          pollAfterMs = Math.max(1, Math.ceil(remaining));
        } else {
          cheap = false;
          const snapshot = record(await runtime.invoke("browser_dom_snapshot", { tabId }, session.sessionId));
          const { observation, nodes, ...content } = snapshot;
          const current = createHash("sha256").update(JSON.stringify({ ...content, nodes: Array.isArray(nodes) ? nodes.map(value => { const { node_id: _id, ...node } = record(value); return node; }) : nodes })).digest("hex");
          if (current !== signature) { signature = current; changedAt = Date.now(); }
          const state = record(observation);
          passed = Date.now() - changedAt >= DOM_QUIET_MS && (typeof state.lastMutationAgeMs !== "number" || state.lastMutationAgeMs >= DOM_QUIET_MS);
        }
      } else if (spec.condition === "exists" || spec.condition === "not-exists") {
        if (target.selector) {
          const value = await runtime.invoke("browser_locator_count", { tabId, selector: target.selector }, session.sessionId);
          passed = spec.condition === "exists" ? value.count > 0 : value.count === 0;
        } else if (target.nodeId) {
          try { await runtime.invoke("browser_page_inspect", { tabId, nodeId: target.nodeId }, session.sessionId); passed = spec.condition === "exists"; }
          catch (error) { if (!/STALE_TARGET|detached|not found|Unknown DOM node/i.test(String(error))) throw error; passed = spec.condition === "not-exists"; }
        } else throw new Error(`settle condition "${spec.condition}" requires a target selector or nodeId`);
      } else {
        if (!target.selector) throw new Error('settle condition "contains" requires a target selector');
        try {
          const value = await runtime.invoke("browser_locator_text", { tabId, selector: target.selector }, session.sessionId);
          passed = value.text.includes(spec.value ?? "");
        } catch (error) {
          if (record(error).code !== "TARGET_NOT_FOUND") throw error;
          passed = false;
        }
      }
      if (passed) return { condition: spec.condition, settled: true };
      await new Promise(resolve => setTimeout(resolve, Math.min(pollAfterMs, Math.max(0, deadlineAt - Date.now()))));
    } while (Date.now() < deadlineAt);
    if (spec.condition === "dom-quiet") return { condition: spec.condition, settled: false, timedOut: true };
    throw new BrowserRuntimeError(`Settle condition timed out: ${spec.condition}`, { code: "SETTLE_TIMEOUT", retryable: false, uncertain: false });
  });
}
