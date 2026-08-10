import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createBrowserOperations } from "../browser/operations/index.js";
import { browserRequest, closeBrowserClients, listBrowserProfiles } from "../browser/client.js";
import { combineUrlPolicyConfig, createUrlPolicy, urlPolicyFromEnv } from "../browser/url-policy.js";
import { ArtifactStore } from "./artifacts.js";
import { createCapabilityRegistry } from "./capabilities.js";
import { contractMetadata } from "./versions.js";
import { createLogger } from "./logging.js";
import { selectProfile as selectConnectedProfile } from "./profiles.js";

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const RISK_WORDS = /\b(delete|remove|send|submit|publish|post|buy|purchase|pay|checkout|confirm|approve|permission|save|sign[ -]?in|log[ -]?in)\b/i;
const READ_ACTIONS = new Set(["find", "hover", "assert", "screenshot", "clipboardRead"]);
const READ_LEGACY_TOOLS = new Set([
  "browser_page_search", "browser_page_inspect", "browser_visual_map", "browser_dom_snapshot",
  "browser_locator_count", "browser_locator_text", "browser_console_logs", "browser_network_events",
  "browser_network_inspect", "browser_download_events", "browser_snapshot", "browser_selected_tab", "browser_list_tabs",
]);
const AUTO_SETTLE_ACTIONS = new Set(["navigate", "reload", "back", "forward", "click", "doubleClick"]);
const PREVIEW_KEY_PRIORITY = [
  "ok", "status", "sessionId", "profileId", "tabId", "url", "title", "query", "scope",
  "totalCandidates", "totalUnits", "totalNodes", "totalEvents", "returned", "truncated", "mode",
  "result", "results", "elements", "nodes", "events", "console", "network", "node_id", "axNodeId",
  "kind", "role", "name", "label", "value", "text", "method", "type", "statusCode", "requestId",
  "timestamp", "error", "summary",
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function parseLegacyResult(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function clamp(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function errorDetails(error) {
  const message = errorMessage(error);
  const timeout = /timed?\s*out|timeout/i.test(message);
  const disconnected = /disconnect|closed target|session.+closed|websocket/i.test(message);
  const validation = error instanceof z.ZodError || /requires |invalid |unsupported |must |missing/i.test(message);
  return {
    code: String(error?.code ?? (timeout ? "TIMEOUT" : validation ? "INVALID_REQUEST" : "BROWSER_OPERATION_FAILED")),
    message,
    retryable: Boolean(error?.retryable ?? timeout ?? disconnected),
    uncertain: Boolean(error?.uncertain ?? timeout ?? disconnected),
  };
}

function isStaleTargetError(error) {
  return /stale|detached|unknown node|node.+not found|no element.+node/i.test(errorMessage(error));
}

function cloneRequest(value) {
  return JSON.parse(JSON.stringify(value));
}

function contextSessionId(args, context) {
  return args.sessionId
    ?? context?.sessionId
    ?? context?.sessionID
    ?? context?.session_id
    ?? `browser-${randomUUID()}`;
}

function resultCandidates(value) {
  if (!value || typeof value !== "object") return [];
  for (const key of ["results", "matches", "units", "items", "elements"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function publicProfiles(profiles) {
  return profiles.map((profile) => ({
    profileId: profile.profileId,
    profileLabel: profile.profileLabel ?? null,
    profileFingerprint: profile.profileFingerprint ?? profile.profileId,
    connectionId: profile.connectionId ?? null,
    connectionGeneration: profile.connectionGeneration ?? null,
    browserName: profile.browserName ?? null,
    browserVersion: profile.browserVersion ?? null,
    extensionVersion: profile.extensionVersion ?? null,
  }));
}

function clippedText(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function projectValue(value, options, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clippedText(value, options.stringLimit);
  if (depth >= options.depthLimit) {
    if (Array.isArray(value)) return `[${value.length} items omitted]`;
    return "[nested value omitted]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, options.arrayLimit).map((item) => projectValue(item, options, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const keys = Object.keys(value);
  const ordered = [
    ...PREVIEW_KEY_PRIORITY.filter((key) => Object.hasOwn(value, key)),
    ...keys.filter((key) => !PREVIEW_KEY_PRIORITY.includes(key)).sort(),
  ].slice(0, options.objectLimit);
  return Object.fromEntries(ordered.map((key) => {
    const child = value[key];
    if (["base64", "data", "body", "postData"].includes(key) && typeof child === "string" && child.length > options.stringLimit) {
      return [key, `[${child.length} characters omitted]`];
    }
    return [key, projectValue(child, options, depth + 1)];
  }));
}

function fitInlinePreview(payload, maxChars) {
  const configurations = [
    { arrayLimit: 20, objectLimit: 30, stringLimit: 500, depthLimit: 7 },
    { arrayLimit: 10, objectLimit: 24, stringLimit: 280, depthLimit: 6 },
    { arrayLimit: 5, objectLimit: 18, stringLimit: 180, depthLimit: 5 },
    { arrayLimit: 2, objectLimit: 14, stringLimit: 120, depthLimit: 4 },
  ];
  for (const options of configurations) {
    const projected = projectValue(payload, options);
    if (JSON.stringify(projected).length <= maxChars) return projected;
  }
  const result = projectValue(payload.result, { arrayLimit: 1, objectLimit: 10, stringLimit: 100, depthLimit: 3 });
  return {
    ok: payload.ok,
    status: payload.status,
    sessionId: payload.sessionId,
    ...(payload.profileId ? { profileId: payload.profileId } : {}),
    ...(payload.tabId ? { tabId: payload.tabId } : {}),
    result,
  };
}

function axValue(field) {
  return field && typeof field === "object" && "value" in field ? field.value : field ?? null;
}

function summarizeAccessibilitySnapshot(snapshot, limit = 40) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const usefulRoles = new Set([
    "RootWebArea", "WebArea", "heading", "link", "button", "textbox", "searchbox", "combobox",
    "checkbox", "radio", "switch", "tab", "menuitem", "dialog", "alert", "status", "listbox", "option",
  ]);
  const useful = nodes.filter((node) => {
    if (node?.ignored === true) return false;
    const role = String(axValue(node?.role) ?? "");
    return usefulRoles.has(role) || Boolean(axValue(node?.name)) || Boolean(axValue(node?.value));
  });
  const selected = useful.slice(0, limit).map((node) => ({
    axNodeId: node.nodeId ?? null,
    backendDOMNodeId: node.backendDOMNodeId ?? null,
    role: axValue(node.role),
    name: clippedText(axValue(node.name), 180) || null,
    value: clippedText(axValue(node.value), 180) || null,
    description: clippedText(axValue(node.description), 180) || null,
  }));
  return { totalNodes: nodes.length, usefulNodes: useful.length, returned: selected.length, truncated: useful.length > selected.length, nodes: selected };
}

function summarizeNetworkEvents(response, limit = 30) {
  const events = Array.isArray(response?.events) ? response.events : [];
  const meaningful = events.map((event) => {
    const params = event?.params ?? {};
    const request = params.request ?? {};
    const responseValue = params.response ?? {};
    return {
      method: event.method ?? null,
      timestamp: event.time ?? params.timestamp ?? null,
      requestId: params.requestId ?? null,
      type: params.type ?? null,
      url: clippedText(responseValue.url ?? request.url ?? params.documentURL, 300) || null,
      httpMethod: request.method ?? null,
      statusCode: responseValue.status ?? null,
      mimeType: responseValue.mimeType ?? null,
      error: clippedText(params.errorText ?? params.blockedReason, 240) || null,
    };
  });
  const selected = meaningful.slice(-limit);
  return { totalEvents: events.length, returned: selected.length, truncated: events.length > selected.length, events: selected };
}

function requiresApproval(steps = []) {
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
    if (step.action === "capability" && step.capability === "network.inspect" && ["request", "response", "both"].includes(step.input?.includeBody)) {
      reasons.push("network body inspection");
    }
  }
  return [...new Set(reasons)];
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("browser_run requires steps, or approvalToken by itself");
  const ids = new Set();
  const required = (step, field) => {
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
      if (!["accept", "dismiss"].includes(step.value)) throw new Error("handleDialog value must be accept or dismiss");
    }
    if (["click", "doubleClick", "hover", "focus", "fill", "replaceText", "select", "upload", "assert"].includes(step.action) && !step.target) {
      throw new Error(`${step.action} requires target`);
    }
  }
}

export class AgentBrowserRuntime {
  constructor({ artifactStore = new ArtifactStore(), approvalTtlMs = APPROVAL_TTL_MS, operationFactory = createBrowserOperations, urlPolicy, urlPolicyConfig, logger } = {}) {
    this.artifacts = artifactStore;
    this.approvalTtlMs = approvalTtlMs;
    this.logger = logger ?? createLogger();
    const envPolicy = urlPolicyFromEnv();
    this.urlPolicy = urlPolicy ?? createUrlPolicy(combineUrlPolicyConfig(
      { allowedOrigins: envPolicy.allowedOrigins, blockedOrigins: envPolicy.blockedOrigins },
      urlPolicyConfig ?? {},
    ));
    this.sessions = new Map();
    this.approvals = new Map();
    this.profileCache = { expiresAt: 0, profiles: [] };
    this.legacyToolsPromise = operationFactory().then((hooks) => hooks.tool);
    this.capabilityRegistry = null;
  }

  getSession(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, profileId: null, activeTabId: null, createdAt: new Date().toISOString() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async invoke(name, args, sessionId) {
    const tools = await this.legacyToolsPromise;
    const definition = tools[name];
    if (!definition) throw new Error(`Legacy operation is unavailable: ${name}`);
    const parsed = z.object(definition.args).parse(args ?? {});
    const attempts = READ_LEGACY_TOOLS.has(name) ? 2 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return parseLegacyResult(await definition.execute(parsed, { sessionID: sessionId, agent: "agent-browser-core", urlPolicy: this.urlPolicy }));
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    throw lastError;
  }

  async capabilities() {
    if (!this.capabilityRegistry) {
      const operations = await this.legacyToolsPromise;
      this.capabilityRegistry = createCapabilityRegistry({
        operations,
        invoke: (name, args, context = {}) => this.invoke(name, args, context.sessionID ?? context.sessionId ?? context.session_id),
      });
    }
    return this.capabilityRegistry;
  }

  async validateCapabilitySteps(steps) {
    const capabilityRegistry = await this.capabilities();
    for (const step of steps) {
      if (step.action !== "capability") continue;
      if (!step.capability) throw new Error("capability action requires capability");
      if (!capabilityRegistry.has(step.capability)) {
        const error = new Error(`Unknown browser capability: ${step.capability}`);
        error.code = "CAPABILITY_NOT_FOUND";
        throw error;
      }
    }
  }

  async connectedProfiles({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.profileCache.expiresAt > now) return this.profileCache.profiles;
    const profiles = await listBrowserProfiles();
    this.profileCache = { profiles, expiresAt: now + 5000 };
    return profiles;
  }

  async selectProfile(session, requested) {
    const profiles = await this.connectedProfiles();
    if (profiles.length === 0) {
      const error = new Error("No connected browser profiles. Open Chromium with the extension installed and retry.");
      error.code = "NO_BROWSER_PROFILE";
      throw error;
    }
    const selector = requested ?? session.profileId;
    let profile;
    try {
      profile = selectConnectedProfile(profiles, selector);
    } catch (error) {
      if (selector && error?.code === "PROFILE_DISCONNECTED") {
        const freshProfiles = await this.connectedProfiles({ fresh: true });
        profile = selectConnectedProfile(freshProfiles, selector);
      } else {
        if (!error.profiles) error.profiles = publicProfiles(profiles);
        throw error;
      }
    }
    if (session.profileId !== profile.profileId) {
      await this.invoke("browser_select_profile", { profileId: profile.profileId }, session.sessionId);
      session.profileId = profile.profileId;
      session.activeTabId = null;
    }
    return profile;
  }

  async ensureTab(session, tab = {}) {
    const mode = tab.mode ?? "current";
    if (mode === "claim") {
      if (!tab.tabId) throw new Error("tab.mode=claim requires tab.tabId");
      const claimed = await this.invoke("browser_claim_tab", { tabId: tab.tabId }, session.sessionId);
      session.activeTabId = claimed.id ?? claimed.tabId ?? tab.tabId;
      return session.activeTabId;
    }
    if (mode === "new") {
      const created = await this.invoke("browser_new_tab", {}, session.sessionId);
      session.activeTabId = created.id ?? created.tabId;
      return session.activeTabId;
    }
    if (tab.tabId) session.activeTabId = tab.tabId;
    if (!session.activeTabId) {
      const selected = await this.invoke("browser_selected_tab", {}, session.sessionId);
      session.activeTabId = selected?.id ?? selected?.tabId ?? null;
    }
    if (!session.activeTabId) {
      const created = await this.invoke("browser_new_tab", {}, session.sessionId);
      session.activeTabId = created.id ?? created.tabId;
    }
    return session.activeTabId;
  }

  pruneApprovals(now = Date.now()) {
    for (const [token, approval] of this.approvals) if (approval.expiresAt <= now) this.approvals.delete(token);
  }

  takeApproval(token) {
    const now = Date.now();
    this.pruneApprovals(now);
    const approval = this.approvals.get(token);
    if (!approval) {
      const error = new Error("Approval token is invalid or expired. Submit the action chain again for review.");
      error.code = "APPROVAL_TOKEN_INVALID";
      throw error;
    }
    this.approvals.delete(token);
    return approval;
  }

  approvalResult(args, sessionId, reasons) {
    const now = Date.now();
    this.pruneApprovals(now);
    const approvalToken = randomUUID();
    const expiresAt = now + this.approvalTtlMs;
    this.approvals.set(approvalToken, { sessionId, request: cloneRequest(args), expiresAt });
    return {
      ...contractMetadata(),
      ok: false,
      status: "approval_required",
      sessionId,
      approvalToken,
      expiresAt: new Date(expiresAt).toISOString(),
      reasons,
      instruction: "Review the chain, then call browser_run with only approvalToken. The immutable stored request will run; no browser action has run yet.",
    };
  }

  async resolveTarget(step, tabId, prior, sessionId) {
    let target = step.target ?? {};
    if (target.fromStep) {
      const source = prior.get(target.fromStep);
      if (!source) throw new Error(`No result available for step ${target.fromStep}`);
      const candidates = resultCandidates(source);
      target = { ...target, ...(candidates[target.index ?? 0] ?? source) };
    }
    if (target.query) {
      const search = await this.invoke("browser_page_search", {
        tabId,
        query: target.query,
        maxResults: Math.max(1, (target.index ?? 0) + 1),
        detail: "lean",
        mode: "snowflake",
      }, sessionId);
      const candidate = resultCandidates(search)[target.index ?? 0];
      if (!candidate) throw new Error(`No page target matched: ${target.query}`);
      target = { ...target, ...candidate };
    }
    if (!target.nodeId) target.nodeId = target.node_id ?? target.id ?? null;
    return target;
  }

  async executeStep(step, tabId, prior, session) {
    const timeoutMs = clamp(step.timeoutMs, 15000, 250, 60000);
    if (step.action === "find") {
      const query = step.target?.query ?? step.value ?? "";
      return this.invoke("browser_page_search", { tabId, query, maxResults: 20, detail: "lean", mode: "snowflake", timeoutMs }, session.sessionId);
    }
    if (step.action === "capability") {
      const registry = await this.capabilities();
      const definition = registry.get(step.capability);
      if (!definition) {
        const error = new Error(`Unknown browser capability: ${step.capability}`);
        error.code = "CAPABILITY_NOT_FOUND";
        throw error;
      }
      const input = { ...(step.input ?? {}), ...(tabId && step.input?.tabId === undefined ? { tabId } : {}) };
      const parsed = registry.validate(step.capability, input);
      return definition.execute(parsed, { sessionID: session.sessionId, sessionId: session.sessionId, profileId: session.profileId, agent: "agent-browser-core", urlPolicy: this.urlPolicy });
    }
    let target = await this.resolveTarget(step, tabId, prior, session.sessionId);
    const dispatch = async () => {
      switch (step.action) {
        case "navigate": return this.invoke("browser_navigate", { tabId, url: step.url, waitUntil: step.waitUntil ?? "domcontentloaded", timeoutMs }, session.sessionId);
        case "reload": return this.invoke("browser_reload", { tabId, bypassCache: step.bypassCache ?? false }, session.sessionId);
        case "back": return this.invoke("browser_back", { tabId }, session.sessionId);
        case "forward": return this.invoke("browser_forward", { tabId }, session.sessionId);
        case "click": return this.clickTarget("browser_click", target, tabId, step, session.sessionId);
        case "doubleClick": return this.clickTarget("browser_double_click", target, tabId, step, session.sessionId);
        case "hover": return this.hoverTarget(target, tabId, session.sessionId);
        case "handleDialog": return this.invoke("browser_handle_dialog", { tabId, value: step.value, promptText: step.promptText }, session.sessionId);
        case "focus": return this.editTarget(target, tabId, "focus", "", session.sessionId);
        case "fill":
        case "replaceText":
        case "select": return this.editTarget(target, tabId, "replace", step.value, session.sessionId);
        case "fillForm": {
          const fields = [];
          for (const [selector, value] of Object.entries(step.fields)) {
            fields.push(await this.invoke("browser_locator_fill", { tabId, selector, value, mode: "replace" }, session.sessionId));
          }
          return { filled: fields.length, fields };
        }
        case "type": {
          if (target.nodeId || target.selector) return this.editTarget(target, tabId, "append", step.value, session.sessionId);
          return this.invoke("browser_type", { tabId, text: step.value }, session.sessionId);
        }
        case "press": return this.invoke("browser_keypress", { tabId, key: step.key }, session.sessionId);
        case "scroll": return this.invoke("browser_scroll", { tabId, x: target.x, y: target.y, scrollX: step.scrollX ?? 0, scrollY: step.scrollY ?? 0 }, session.sessionId);
        case "drag": return this.invoke("browser_drag", { tabId, path: step.path, button: step.button ?? "left" }, session.sessionId);
        case "assert": return this.assertTarget(target, tabId, step, session.sessionId);
        case "upload": return this.invoke("browser_set_file_input", { tabId, selector: target.selector ?? "input[type=file]", files: step.files }, session.sessionId);
        case "clipboardRead": return this.invoke("browser_clipboard_read_text", { tabId }, session.sessionId);
        case "clipboardWrite": return this.invoke("browser_clipboard_write_text", { tabId, text: step.value }, session.sessionId);
        case "screenshot": return this.screenshot(tabId, step, session.sessionId);
        case "close": {
          const result = await this.invoke("browser_close_tab", { tabId }, session.sessionId);
          session.activeTabId = null;
          return result;
        }
        default: throw new Error(`Unsupported action: ${step.action}`);
      }
    };
    try {
      return await dispatch();
    } catch (error) {
      if (!isStaleTargetError(error) || (!step.target?.selector && !step.target?.query)) throw error;
      target = await this.resolveTarget({ ...step, target: { ...step.target, nodeId: undefined } }, tabId, prior, session.sessionId);
      return dispatch();
    }
  }

  async editTarget(target, tabId, mode, value, sessionId) {
    if (target.nodeId) return this.invoke("browser_dom_type", { tabId, nodeId: target.nodeId, text: value, mode }, sessionId);
    if (target.selector) return this.invoke("browser_locator_fill", { tabId, selector: target.selector, value, mode }, sessionId);
    throw new Error("Editable target needs nodeId, selector, or query");
  }

  async clickTarget(toolName, target, tabId, step, sessionId) {
    if (target.nodeId) {
      if (toolName === "browser_double_click") throw new Error("doubleClick requires selector or coordinates");
      return this.invoke("browser_dom_click", { tabId, nodeId: target.nodeId }, sessionId);
    }
    if (target.selector) {
      if (toolName === "browser_double_click") throw new Error("doubleClick by selector is not supported; use coordinates");
      return this.invoke("browser_locator_click", { tabId, selector: target.selector }, sessionId);
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return this.invoke(toolName, { tabId, x: target.x, y: target.y, button: step.button ?? "left" }, sessionId);
    }
    throw new Error(`${step.action} target needs nodeId, selector, query, or coordinates`);
  }

  async hoverTarget(target, tabId, sessionId) {
    if (target.nodeId) return this.invoke("browser_hover", { tabId, nodeId: target.nodeId }, sessionId);
    if (target.selector) return this.invoke("browser_hover", { tabId, selector: target.selector }, sessionId);
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return this.invoke("browser_hover", { tabId, x: target.x, y: target.y }, sessionId);
    }
    throw new Error("hover target needs nodeId, selector, query, or coordinates");
  }

  async assertTarget(target, tabId, step, sessionId) {
    const condition = step.condition ?? "exists";
    if (!target.selector && target.nodeId && condition === "exists") {
      await this.invoke("browser_page_inspect", { tabId, nodeId: target.nodeId }, sessionId);
      return { passed: true, condition, nodeId: target.nodeId };
    }
    if (!target.selector) throw new Error("assert requires target.selector, or nodeId for an exists check");
    if (condition === "exists" || condition === "not-exists") {
      const { count } = await this.invoke("browser_locator_count", { tabId, selector: target.selector }, sessionId);
      const passed = condition === "exists" ? count > 0 : count === 0;
      if (!passed) throw new Error(`Assertion failed: ${target.selector} ${condition}`);
      return { passed, condition, count };
    }
    const { text } = await this.invoke("browser_locator_text", { tabId, selector: target.selector }, sessionId);
    const expected = step.value ?? "";
    const passed = condition === "equals" ? text === expected : text.includes(expected);
    if (!passed) throw new Error(`Assertion failed: text ${condition} ${JSON.stringify(expected)}`);
    return { passed, condition, text };
  }

  async settleStep(step, tabId, prior, session) {
    const spec = step.settle ?? (AUTO_SETTLE_ACTIONS.has(step.action) ? { condition: "dom-quiet" } : null);
    if (!spec) return null;
    const timeoutMs = clamp(spec.timeoutMs, 2500, 100, 15000);
    const deadline = Date.now() + timeoutMs;
    const target = await this.resolveTarget({ target: spec.target ?? step.target }, tabId, prior, session.sessionId);
    if (spec.condition === "dom-quiet") {
      let previous = null;
      let stableCount = 0;
      do {
        const snapshot = await this.invoke("browser_dom_snapshot", { tabId }, session.sessionId);
        const current = digest(snapshot);
        stableCount = current === previous ? stableCount + 1 : 0;
        if (stableCount >= 1) return { condition: "dom-quiet", settled: true };
        previous = current;
        await new Promise((resolve) => setTimeout(resolve, 120));
      } while (Date.now() < deadline);
      return { condition: "dom-quiet", settled: false, timedOut: true };
    }
    if (spec.condition === "contains" && !target.selector) {
      throw new Error(`settle condition "contains" requires a target selector`);
    }
    if ((spec.condition === "exists" || spec.condition === "not-exists") && !target.selector && !target.nodeId) {
      throw new Error(`settle condition "${spec.condition}" requires a target selector or nodeId`);
    }
    do {
      let passed = false;
      if (spec.condition === "exists" || spec.condition === "not-exists") {
        if (target.selector) {
          const { count } = await this.invoke("browser_locator_count", { tabId, selector: target.selector }, session.sessionId);
          passed = spec.condition === "exists" ? count > 0 : count === 0;
        } else if (target.nodeId) {
          try {
            await this.invoke("browser_page_inspect", { tabId, nodeId: target.nodeId }, session.sessionId);
            passed = spec.condition === "exists";
          } catch {
            passed = spec.condition === "not-exists";
          }
        }
      } else if (spec.condition === "contains" && target.selector) {
        const { text } = await this.invoke("browser_locator_text", { tabId, selector: target.selector }, session.sessionId);
        passed = String(text ?? "").includes(spec.value ?? "");
      }
      if (passed) return { condition: spec.condition, settled: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    const error = new Error(`Settle condition timed out: ${spec.condition}`);
    error.code = "SETTLE_TIMEOUT";
    error.retryable = true;
    throw error;
  }

  async observeValue(args, tabId, session) {
    const limit = clamp(args.limit, args.mode === "visual" ? 25 : 12, 1, 200);
    const target = args.target ?? {};
    if (args.mode === "capabilities") return (await this.capabilities()).manifest(args.pack ?? "core");
    if (args.mode === "artifact") {
      const artifact = this.artifacts.read(args.uri, { sessionId: session.sessionId });
      if (!artifact) throw new Error("Artifact expired, missing, or belongs to another browser session.");
      const { data, ...metadata } = artifact;
      return { ...metadata, ...(args.delivery === "inline" ? { base64: data.toString("base64") } : { preview: data.toString("utf8").slice(0, 4096) }) };
    }
    if (args.mode === "search") return this.invoke("browser_page_search", {
      tabId,
      query: args.query ?? target.query ?? "",
      maxResults: limit,
      detail: args.detail ?? "lean",
      mode: args.searchStrategy ?? "snowflake",
      timeoutMs: ["deep", "snowflake"].includes(args.searchStrategy ?? "snowflake") ? 120000 : 10000,
    }, session.sessionId);
    if (args.mode === "inspect") return this.invoke("browser_page_inspect", {
      tabId,
      nodeId: target.nodeId,
      selector: target.selector ?? (!target.nodeId ? 'dialog[open], [role="dialog"], body' : undefined),
      depth: args.detail === "full" || args.detail === "debug" ? 2 : 1,
      maxChildren: limit,
      maxText: args.detail === "full" || args.detail === "debug" ? 700 : 280,
    }, session.sessionId);
    if (args.mode === "visual") return this.invoke("browser_visual_map", {
      tabId,
      query: args.query ?? target.query,
      selector: target.selector,
      nodeId: target.nodeId,
      maxResults: limit,
      detail: args.detail === "debug" ? "debug" : "lean",
    }, session.sessionId);
    if (args.mode === "extract") return target.selector
      ? this.invoke("browser_locator_text", { tabId, selector: target.selector }, session.sessionId)
      : this.invoke("browser_page_search", { tabId, query: args.query ?? target.query ?? "main content", maxResults: limit, detail: args.detail ?? "compact", mode: args.searchStrategy ?? "snowflake", timeoutMs: ["deep", "snowflake"].includes(args.searchStrategy ?? "snowflake") ? 120000 : 10000 }, session.sessionId);
    if (args.mode === "events") return {
      console: await this.invoke("browser_console_logs", { tabId, limit: clamp(args.limit, 50, 1, 200), raw: false, includeStack: false }, session.sessionId),
      network: summarizeNetworkEvents(await this.invoke("browser_network_events", { tabId, limit: clamp(args.limit, 50, 1, 200) }, session.sessionId), clamp(args.limit, 30, 1, 200)),
      dialogs: await this.invoke("browser_dialog_events", { tabId, limit: clamp(args.limit, 20, 1, 100) }, session.sessionId),
    };
    if (args.mode === "downloads") return this.invoke("browser_download_events", { limit: clamp(args.limit, 100, 1, 200) }, session.sessionId);
    if (args.mode === "screenshot") return this.screenshot(tabId, args, session.sessionId);
    if (args.mode === "raw-snapshot") return this.invoke("browser_snapshot", { tabId }, session.sessionId);
    throw new Error(`Unsupported observation mode: ${args.mode}`);
  }

  async screenshot(tabId, options, sessionId) {
    const shot = await this.invoke("browser_screenshot", { tabId, fullPage: options.fullPage ?? false, timeoutMs: options.timeoutMs ?? 30000 }, sessionId);
    if (options.delivery === "inline") return shot;
    const artifact = this.artifacts.create({ sessionId, mimeType: shot.mimeType, data: Buffer.from(shot.base64, "base64"), label: "screenshot" });
    return { screenshot: artifact };
  }

  compact(payload, sessionId, maxChars = 4096, label = "result", inlinePayload = payload) {
    const versionedPayload = { ...contractMetadata(), ...payload };
    const serialized = JSON.stringify(versionedPayload);
    if (serialized.length <= maxChars) return versionedPayload;
    const artifact = this.artifacts.create({ sessionId, mimeType: "application/json", data: versionedPayload, label });
    const preview = fitInlinePreview(inlinePayload, Math.max(256, maxChars - 700));
    return {
      ...contractMetadata(),
      ...preview,
      ok: versionedPayload.ok,
      status: versionedPayload.status,
      sessionId,
      truncated: true,
      summary: versionedPayload.summary ?? `${label} was truncated to a useful inline preview; the complete result is optional at artifact.uri`,
      artifact,
    };
  }

  failure(sessionId, error, extra = {}) {
    const detail = errorDetails(error);
    return {
      ...contractMetadata(),
      ok: false,
      status: detail.code.toLocaleLowerCase(),
      sessionId,
      error: detail,
      ...(error?.profiles ? { profiles: error.profiles } : {}),
      ...extra,
    };
  }

  async run(args, context = {}) {
    let request = args;
    let sessionId = contextSessionId(args, context);
    let approved = false;
    try {
      if (args.approvalToken) {
        const extraKeys = Object.keys(args).filter((key) => !["approvalToken", "sessionId"].includes(key) && args[key] !== undefined);
        if (extraKeys.length > 0) throw new Error("An approval follow-up must contain only approvalToken");
        const stored = this.takeApproval(args.approvalToken);
        request = stored.request;
        sessionId = stored.sessionId;
        approved = true;
      }
      validateSteps(request.steps);
      await this.validateCapabilitySteps(request.steps);
      const reasons = requiresApproval(request.steps);
      if (reasons.length > 0 && !approved) return this.approvalResult(request, sessionId, reasons);
      const session = this.getSession(sessionId);
      await this.selectProfile(session, request.profile);
      const tabId = await this.ensureTab(session, request.tab);
      const prior = new Map();
      const results = [];
      let failed = false;
      try {
        for (const [index, step] of request.steps.entries()) {
          let value;
          let lastError;
          const attempts = READ_ACTIONS.has(step.action) ? (step.retry ?? 0) + 1 : 1;
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
              value = await this.executeStep(step, tabId, prior, session);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError) {
            failed = true;
            const detail = errorDetails(lastError);
            let observation;
            if (!READ_ACTIONS.has(step.action) && detail.uncertain && session.activeTabId) {
              observation = await this.observeValue({ mode: "inspect", target: step.target, detail: "lean", limit: 8 }, tabId, session).catch(() => undefined);
            }
            results.push({ index, id: step.id ?? null, action: step.action, ok: false, error: detail, ...(observation ? { observation } : {}) });
            if (step.onError !== "continue") break;
            continue;
          }
          let settled;
          try {
            settled = await this.settleStep(step, tabId, prior, session);
          } catch (error) {
            if (step.settle) {
              failed = true;
              results.push({ index, id: step.id ?? null, action: step.action, ok: false, result: value, error: errorDetails(error) });
              if (step.onError !== "continue") break;
            } else {
              settled = { settled: false, degraded: true, error: errorDetails(error) };
            }
          }
          if (step.id) prior.set(step.id, value);
          if (!failed || results.at(-1)?.index !== index) results.push({ index, id: step.id ?? null, action: step.action, ok: true, result: value, ...(settled ? { settle: settled } : {}) });
        }
      } finally {
        await this.invoke("browser_turn_end", {}, sessionId).catch(() => {});
      }
      let postObservation;
      if (request.postObserve && session.activeTabId) {
        try {
          postObservation = await this.observeValue(request.postObserve, session.activeTabId, session);
        } catch (error) {
          failed = true;
          postObservation = { ok: false, error: errorDetails(error) };
        }
      }
      const mode = request.returnMode ?? "last";
      const selectedResults = mode === "all" ? results : mode === "last" ? results.slice(-1) : results.map(({ result, ...item }) => ({
        ...item,
        ...(result?.screenshot ? { artifact: result.screenshot } : result?.artifact ? { artifact: result.artifact } : {}),
      }));
      return this.compact({
        ok: !failed,
        status: failed ? "partial" : "completed",
        sessionId,
        profileId: session.profileId,
        tabId: session.activeTabId,
        summary: `${results.filter((item) => item.ok).length}/${request.steps.length} actions completed`,
        results: selectedResults,
        ...(postObservation !== undefined ? { observation: postObservation } : {}),
      }, sessionId, clamp(request.maxChars, 4096, 512, 20000), "run");
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async observe(args, context = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      if (args.mode === "capabilities") {
        const registry = await this.capabilities();
        return { ...contractMetadata(), ok: true, status: "capabilities", sessionId, result: registry.manifest(args.pack ?? "core") };
      }
      if (args.mode === "artifact") {
        const artifact = this.artifacts.read(args.uri, { sessionId });
        if (!artifact) throw new Error("Artifact expired, missing, or belongs to another browser session.");
        const isText = artifact.mimeType.startsWith("text/") || artifact.mimeType === "application/json";
        const preview = isText ? artifact.data.toString("utf8").slice(0, clamp(args.maxChars, 4096, 256, 20000)) : null;
        const { data, ...metadata } = artifact;
        return { ...contractMetadata(), ok: true, status: "artifact", sessionId, result: { ...metadata, ...(preview !== null ? { preview } : {}), ...(args.delivery === "inline" ? { base64: data.toString("base64") } : {}) } };
      }
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const tabId = args.tabId ?? session.activeTabId ?? (await this.invoke("browser_selected_tab", {}, sessionId))?.id;
      if (!tabId) throw new Error("No controlled tab is selected. Create or claim one with browser_session.");
      session.activeTabId = tabId;
      const value = await this.observeValue(args, tabId, session);
      const payload = { ok: true, status: "observed", sessionId, profileId: session.profileId, tabId, result: value };
      const inlineValue = args.mode === "raw-snapshot" ? summarizeAccessibilitySnapshot(value, clamp(args.limit, 40, 1, 200)) : value;
      return this.compact(payload, sessionId, clamp(args.maxChars, 4096, 512, 20000), "observe", { ...payload, result: inlineValue });
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async session(args, context = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      if (args.action === "open") {
        const profiles = await this.connectedProfiles({ fresh: true });
        if (!args.profile && !session.profileId && profiles.length !== 1) {
          const error = new Error(profiles.length > 1 ? "Multiple profiles are connected; pass the user-named profile on open." : "No browser profile is connected.");
          error.code = profiles.length > 1 ? "PROFILE_SELECTION_REQUIRED" : "NO_BROWSER_PROFILE";
          error.profiles = publicProfiles(profiles);
          throw error;
        }
      }
      const profile = await this.selectProfile(session, args.profile);
      let value = null;
      if (args.action === "open") {
        value = await this.invoke("browser_list_tabs", { scope: args.scope ?? "session" }, sessionId);
      } else if (args.action === "new-tab") {
        const tab = await this.invoke("browser_new_tab", {}, sessionId);
        session.activeTabId = tab.id ?? tab.tabId;
        value = tab;
      } else if (args.action === "claim-tab") {
        if (!args.tabId) throw new Error("claim-tab requires tabId");
        const tab = await this.invoke("browser_claim_tab", { tabId: args.tabId }, sessionId);
        session.activeTabId = tab.id ?? tab.tabId ?? args.tabId;
        value = tab;
      } else if (args.action === "release-tab") {
        if (!args.tabId) throw new Error("release-tab requires tabId");
        value = await browserRequest("releaseTab", { session_id: sessionId, profile_id: profile.profileId, tabId: args.tabId }, { profileId: profile.profileId });
        if (session.activeTabId === args.tabId) session.activeTabId = null;
      } else if (args.action === "name") {
        if (!args.name) throw new Error("name requires name");
        value = await this.invoke("browser_name_session", { name: args.name }, sessionId);
      }
      return { ...contractMetadata(), ok: true, status: "ready", sessionId, profileId: profile.profileId, activeTabId: session.activeTabId, result: value };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async finalize(args, context = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const result = await this.invoke("browser_finalize", { keep: args.keep ?? [] }, sessionId);
      this.sessions.delete(sessionId);
      this.artifacts.cleanupSession(sessionId);
      return { ...contractMetadata(), ok: true, status: "finalized", sessionId, result };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  close() {
    this.artifacts.close();
    this.sessions.clear();
    this.approvals.clear();
    this.capabilityRegistry = null;
    closeBrowserClients();
  }
}

export function createAgentBrowserRuntime(options) {
  return new AgentBrowserRuntime(options);
}
