import { record } from "../shared/values.ts";
import type { Step } from "./registry.ts";

const RISK_WORDS = /\b(delete|remove|send|submit|publish|post|buy|purchase|pay|checkout|confirm|approve|permission|save|sign[ -]?in|log[ -]?in)\b/i;
export function requiresApproval(steps: Step[] = []) {
  const reasons = [];
  const named = new Map(steps.filter((step) => step.id).map((step) => [step.id, step]));
  for (const step of steps) {
    const referenced = step.target?.fromStep ? named.get(step.target.fromStep) : null;
    const targetText = JSON.stringify([step.target ?? {}, referenced?.target ?? {}, referenced?.value]);
    if (["upload", "clipboardRead", "clipboardWrite", "close"].includes(step.action)) reasons.push(step.action);
    if (step.action === "handleDialog" && step.value === "accept") reasons.push("dialog accept");
    if (step.action === "press" && /^(enter|return)$/i.test(step.key ?? "")) reasons.push("submit-capable key press");
    if (["click", "doubleClick"].includes(step.action) && RISK_WORDS.test(targetText)) reasons.push("consequential click target");
    if (["fill", "replaceText", "fillForm", "type"].includes(step.action) && /password|passcode|otp|credit.?card|cvv/i.test(`${targetText} ${JSON.stringify(step.fields ?? {})}`)) {
      reasons.push("sensitive form input");
    }
    if (step.action === "capability" && /clipboard\.write|uploads\.|forms\.|advanced\.(drag|locator)/i.test(step.capability ?? "")) reasons.push(`capability ${step.capability}`);
    const includeBody = record(step.input).includeBody;
    if (step.action === "capability" && step.capability === "network.inspect" && typeof includeBody === "string" && ["request", "response", "both"].includes(includeBody)) {
      reasons.push("network body inspection");
    }
  }
  return [...new Set(reasons)];
}

export function validateSteps(steps: Step[] | undefined): asserts steps is Step[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("browser_run requires steps, or approvalToken by itself");
  const ids = new Set();
  const required = (step: Step, field: keyof Step) => {
    if (step[field] === undefined) throw new Error(`${step.action} requires ${field}`);
  };
  for (const [index, step] of steps.entries()) {
    if (step.id) {
      if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
      ids.add(step.id);
    }
    if (step.target?.fromStep && !ids.has(step.target.fromStep)) {
      throw new Error(`steps[${index}].target.fromStep must reference an earlier named step`);
    }
    if (step.action === "navigate") required(step, "url");
    if (step.action === "navigate" && !(/^https?:\/\//i.test(step.url ?? "") || step.url === "about:blank")) {
      throw new Error("navigate supports http://, https://, and about:blank URLs only");
    }
    if (["fill", "replaceText", "select", "type", "clipboardWrite"].includes(step.action)) required(step, "value");
    if (step.action === "fillForm") required(step, "fields");
    if (step.action === "press") required(step, "key");
    if (step.action === "drag") required(step, "path");
    if (step.action === "upload") required(step, "files");
    if (step.action === "capability") required(step, "capability");
    if (step.action === "handleDialog") {
      required(step, "value");
      if (!["accept", "dismiss"].includes(step.value ?? "")) throw new Error("handleDialog value must be accept or dismiss");
    }
    if (["click", "doubleClick", "hover", "focus", "fill", "replaceText", "select", "upload", "assert"].includes(step.action) && !step.target) {
      throw new Error(`${step.action} requires target`);
    }
  }
}
