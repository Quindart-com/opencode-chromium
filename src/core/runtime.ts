import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { RecipeStep } from "../../native-host/src/memory/recipe.ts";
import { recipeSchema } from "../../native-host/src/memory/recipe.ts";
import { browserRequest,closeBrowserClients,listBrowserProfiles } from "../browser/client.ts";
import { createFilePolicy,filePolicyFromEnv } from "../browser/file-policy.ts";
import type { BrowserOperation } from "../browser/operation-definition.ts";
import { createBrowserOperations } from "../browser/operations/index.ts";
import { assertNavigationAllowed,combineUrlPolicyConfig,createUrlPolicy,urlPolicyFromEnv } from "../browser/url-policy.ts";
import { record } from "../shared/values.ts";
import { partialDispatchError } from "../shared/execution-state.ts";
import { nodeFrameId } from "../browser/operations/page-state.ts";
import { ArtifactStore } from "./artifacts.ts";
import { createCapabilityRegistry } from "./capabilities.ts";
import { cleanupSessionEnvironment } from "./environment-cleanup.ts";
import { BrowserRuntimeError } from "./errors.ts";
import { errorDetails,shouldReobservePage } from "./failure-context.ts";
import { createLogger } from "./logging.ts";
import { createObservationOperations } from "./observation-diffs.ts";
import { fitInlinePreview,summarizeAccessibilitySnapshot,summarizeNetworkEvents } from './observation-projection.ts';
import { candidateSchema,parseOperationResult,screenshotResultSchema,type OperationResult } from "./operation-results.ts";
import type { BrowserProfile } from "./profiles.ts";
import { selectProfile as selectConnectedProfile } from "./profiles.ts";
import type { FinalizeInput,MemoryQueryInput,MemorySearchInput,MemoryStatusInput,ObserveInput,RunInput,SessionInput,Step,Target } from "./registry.ts";
import { runInputSchema } from "./registry.ts";
import { replayGateRejection } from "./replay-gate.ts";
import { requiresApproval,validateSteps } from './run-validation.ts';
import type { PendingApproval,RuntimeOptions,RuntimeSession,SearchPreferences } from "./runtime-types.ts";
import type { BrowserContext } from "./tool-definition.ts";
import { settleBrowserStep } from "./settling.ts";
import { responseMetadata as contractMetadata } from "./versions.ts";

type PriorResults = Map<string, unknown>;
type ResolvedTarget = Target & { node_id?: string | number | null; id?: string | number | null };
type MemoryCapture = { enabled: boolean; paused: boolean; embedding_profile?: string | null };
const memoryMatchSchema = z.looseObject({ id: z.number().optional(), kind: z.string(), steps: z.array(recipeSchema), embedding_profile: z.string().nullable().optional(), confidence: z.number().optional(), similarity: z.number().optional(), deterministic: z.boolean().optional(), failed_count: z.number().optional() });
type RunStepResult = { index: number; action: Step["action"]; id?: string | null; ok: boolean; result?: unknown; error?: ReturnType<typeof errorDetails>; settle?: unknown; observation?: unknown };
function summarizeStepResult(item: RunStepResult) { const { result, ...rest } = item; const value = record(result); return { ...rest, ...(value.screenshot ? { artifact: value.screenshot } : value.artifact ? { artifact: value.artifact } : {}) }; }
type StepOutcome = { ok: true; value: unknown; settled: unknown; executionState: string } | { ok: false; error: ReturnType<typeof errorDetails>; rawError: unknown; value: unknown; settled: unknown; executionState: string };
type ReplayOutcome = { used: true; stepsReused: number; results: RunStepResult[]; failed?: boolean } | { used?: false; fallback: true; supersedes?: number | null } | null;
type StepExecution = { step: Step; index: number; tabId: number; prior: PriorResults; session: RuntimeSession; chainId: string; memoryEnabled: boolean };
type ScreenshotOptions = { fullPage?: boolean; format?: "png" | "jpeg" | "webp"; quality?: number; timeoutMs?: number; delivery?: "artifact" | "inline" };
type ResultPayload = Record<string, unknown> & { ok: boolean; status: string; sessionId: string; summary?: string };
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const READ_ACTIONS = new Set(["find", "hover", "assert", "screenshot", "clipboardRead"]);
const READ_LEGACY_TOOLS = new Set([
  "browser_page_search", "browser_page_inspect", "browser_visual_map", "browser_dom_snapshot",
  "browser_locator_count", "browser_locator_text", "browser_console_logs", "browser_network_events",
  "browser_network_inspect", "browser_download_events", "browser_snapshot", "browser_selected_tab", "browser_list_tabs",
]);

function parseLegacyResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function isStaleTargetError(error: unknown) {
  return /stale|detached|unknown node|node.+not found|no element.+node/i.test(errorMessage(error));
}

function cloneRequest(value: RunInput): RunInput {
  return runInputSchema.parse(JSON.parse(JSON.stringify(value)) as unknown);
}

function contextSessionId(args: { sessionId?: string | null }, context: BrowserContext) {
  return args.sessionId
    ?? context?.sessionId
    ?? context?.sessionID
    ?? context?.session_id
    ?? `browser-${randomUUID()}`;
}

function resultCandidates(value: unknown): z.infer<typeof candidateSchema>[] {
  if (!value || typeof value !== "object") return [];
  for (const key of ["results", "matches", "units", "items", "elements"]) {
    if (Array.isArray(record(value)[key])) return (record(value)[key] as unknown[]).flatMap(value => { const parsed = candidateSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  }
  return [];
}

function usesLongSearchTimeout(strategy: string) {
  return ["deep", "semantic", "snowflake"].includes(strategy);
}

function normalizedTargetText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLocaleLowerCase() : null;
}

function rememberedStepMismatch(remembered: RecipeStep, source: Step | undefined, hostname: string | null) {
  if (!source) return "target_mismatch";
  if (remembered.action !== source.action) return "action_mismatch";
  if (remembered.hostname && hostname && remembered.hostname !== hostname) return "hostname_mismatch";
  const sourceTarget = source.target ?? {};
  const sourceRole = normalizedTargetText(sourceTarget.role);
  const rememberedRole = normalizedTargetText(remembered.target_role);
  if (sourceRole && rememberedRole && sourceRole !== rememberedRole) return "target_mismatch";
  const sourceLabel = normalizedTargetText(sourceTarget.query ?? record(sourceTarget).label);
  const rememberedLabel = normalizedTargetText(remembered.target_label);
  if (sourceLabel && rememberedLabel && sourceLabel !== rememberedLabel) return "target_mismatch";
  const sourceSelector = normalizedTargetText(sourceTarget.selector);
  const rememberedSelector = normalizedTargetText(remembered.selector);
  if (sourceSelector && rememberedSelector && sourceSelector !== rememberedSelector) return "target_mismatch";
  return null;
}

function publicProfiles(profiles: BrowserProfile[]) {
  return profiles.map(profile => ({
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

export class AgentBrowserRuntime {
  readonly operationScope = new AsyncLocalStorage<{ frameId?: string; deadlineAt?: number }>();
  readonly artifacts: ArtifactStore;
  readonly approvalTtlMs: number;
  readonly logger: ReturnType<typeof createLogger>;
  readonly urlPolicy: ReturnType<typeof createUrlPolicy>;
  readonly filePolicy: ReturnType<typeof createFilePolicy>;
  readonly sessions: Map<string, RuntimeSession>;
  readonly approvals: Map<string, PendingApproval>;
  profileCache: { expiresAt: number; profiles: BrowserProfile[] };
  readonly legacyToolsPromise: Promise<Record<string, BrowserOperation>>;
  readonly hostRequest: NonNullable<RuntimeOptions["hostRequest"]>;
  capabilityRegistry: ReturnType<typeof createCapabilityRegistry> | null;
  readonly observationOperations: ReturnType<typeof createObservationOperations>;
  readonly searchPrefsCache: Map<string, { value: SearchPreferences; expiresAt: number }>;
  memoryChainSequence: number;
  constructor({ artifactStore = new ArtifactStore(), approvalTtlMs = APPROVAL_TTL_MS, operationFactory = createBrowserOperations, hostRequest = browserRequest, urlPolicy, urlPolicyConfig, filePolicy, filePolicyConfig, logger }: RuntimeOptions = {}) {
    this.artifacts = artifactStore;
    this.approvalTtlMs = approvalTtlMs;
    this.logger = logger ?? createLogger();
    const envPolicy = urlPolicyFromEnv();
    this.urlPolicy = urlPolicy ?? createUrlPolicy(combineUrlPolicyConfig(
      { allowedOrigins: envPolicy.allowedOrigins, blockedOrigins: envPolicy.blockedOrigins },
      urlPolicyConfig ?? {},
    ));
    const envFilePolicy = filePolicyFromEnv();
    this.filePolicy = filePolicy ?? createFilePolicy({
      allowedFileRoots: filePolicyConfig?.allowedFileRoots ?? envFilePolicy.allowedFileRoots,
    });
    this.sessions = new Map();
    this.approvals = new Map();
    this.profileCache = { expiresAt: 0, profiles: [] };
    this.legacyToolsPromise = operationFactory().then((hooks) => hooks.tool);
    this.hostRequest = hostRequest;
    this.capabilityRegistry = null;
    this.observationOperations = createObservationOperations(this);
    this.searchPrefsCache = new Map();
    this.memoryChainSequence = 0;
  }

  async requestHost(method: string, params: Record<string, unknown> = {}, session: RuntimeSession | null = null) {
    return this.hostRequest(method, params, session?.profileId ? { profileId: session.profileId } : {});
  }

  getSession(sessionId: string): RuntimeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, profileId: null, activeTabId: null, configuredTabs: new Map(), createdAt: new Date().toISOString() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async invoke<K extends string>(name: K, args: Record<string, unknown>, sessionId: string): Promise<OperationResult<K>> {
    const tools = await this.legacyToolsPromise;
    const definition = (this.observationOperations as Record<string, BrowserOperation>)[name] ?? tools[name];
    if (!definition) throw new Error(`Legacy operation is unavailable: ${name}`);
    const parsed = z.object(definition.args).parse(args ?? {});
    const context = { ...this.operationScope.getStore(), sessionID: sessionId, agent: "agent-browser-core", urlPolicy: this.urlPolicy, filePolicy: this.filePolicy,
      ...(typeof args.frameId === "string" ? { frameId: args.frameId } : nodeFrameId(args.nodeId) ? { frameId: nodeFrameId(args.nodeId) } : {}) };
    const checkTab = async (after = false) => {
      if (this.urlPolicy.allowedOrigins?.length === 0 && this.urlPolicy.blockedOrigins?.length === 0) return;
      if (!parsed.tabId || !tools.browser_get_tab || ["browser_claim_tab", "browser_close_tab", "browser_configure"].includes(name)) return;
      if (!after && name === "browser_navigate") { assertNavigationAllowed(z.string().parse(parsed.url), this.urlPolicy); return; }
      const tab = parseLegacyResult(await tools.browser_get_tab.execute({ tabId: parsed.tabId }, context));
      assertNavigationAllowed(z.string().parse(record(tab).url), this.urlPolicy);
    };
    await checkTab();
    const attempts = READ_LEGACY_TOOLS.has(name) ? 2 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const value = parseLegacyResult(await definition.execute(parsed, context));
        await checkTab(true);
        return parseOperationResult(name, value);
      } catch (error) {
        lastError = error;
        if (record(error).retryable === false) throw error;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    throw lastError;
  }

  async capabilities() {
    if (!this.capabilityRegistry) {
      const operations = await this.legacyToolsPromise;
      this.capabilityRegistry = createCapabilityRegistry({
        operations: Object.defineProperties({ ...this.observationOperations }, Object.getOwnPropertyDescriptors(operations)),
        invoke: (name, args, context = {}) => this.invoke(name, record(args), context.sessionID ?? context.sessionId ?? context.session_id ?? "opencode"),
      });
    }
    return this.capabilityRegistry;
  }

  async validateCapabilitySteps(steps: Step[]) {
    const capabilityRegistry = await this.capabilities();
    for (const step of steps) {
      if (step.action !== "capability") continue;
      if (!step.capability) throw new Error("capability action requires capability");
      if (!capabilityRegistry.has(step.capability)) {
        const error = new BrowserRuntimeError(`Unknown browser capability: ${step.capability}`, { code: "CAPABILITY_NOT_FOUND" });
        throw error;
      }
    }
  }

  spillNetworkBodies(result: unknown, sessionId: string) {
    const output = record(result);
    const source = output.events;
    const events = Array.isArray(source) ? source.map(record) : [];
    for (const event of events) {
      for (const [rawKey, outKey] of [["requestBodyRaw", "requestBody"], ["responseBodyRaw", "responseBody"]] as const) {
        if (typeof event[rawKey] === "string") {
          const artifact = this.artifacts.create({
            sessionId,
            mimeType: "application/json",
            data: event[rawKey],
            label: `network-${outKey}`,
          });
          event[outKey] = { artifact: artifact.uri, mimeType: artifact.mimeType, length: event[rawKey].length };
          delete event[rawKey];
        }
      }
    }
    output.bodyDelivery = "artifact";
    return output;
  }

  async connectedProfiles({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.profileCache.expiresAt > now) return this.profileCache.profiles;
    const profiles = await listBrowserProfiles();
    this.profileCache = { profiles, expiresAt: now + 5000 };
    return profiles;
  }

  async selectProfile(session: RuntimeSession, requested: string | null | undefined) {
    const profiles = await this.connectedProfiles();
    if (profiles.length === 0) {
      const error = new BrowserRuntimeError("No connected browser profiles. Open Chromium with the extension installed and retry.", { code: "NO_BROWSER_PROFILE" });
      throw error;
    }
    const selector = requested ?? session.profileId;
    let profile;
    try {
      profile = selectConnectedProfile(profiles, selector);
    } catch (error) {
      if (selector && record(error).code === "PROFILE_DISCONNECTED") {
        const freshProfiles = await this.connectedProfiles({ fresh: true });
        profile = selectConnectedProfile(freshProfiles, selector);
      } else {
        if (error instanceof Error && !record(error).profiles) Object.assign(error, { profiles: publicProfiles(profiles) });
        throw error;
      }
    }
    if (session.profileId !== profile.profileId) {
      await this.invoke("browser_select_profile", { profileId: profile.profileId }, session.sessionId);
      session.profileId = profile.profileId;
      session.activeTabId = null;
      this.searchPrefsCache.clear();
    }
    return profile;
  }

  async ensureTab(session: RuntimeSession, tab: NonNullable<RunInput["tab"]> = {}) {
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

  takeApproval(token: string) {
    const now = Date.now();
    this.pruneApprovals(now);
    const approval = this.approvals.get(token);
    if (!approval) {
      const error = new BrowserRuntimeError("Approval token is invalid or expired. Submit the action chain again for review.", { code: "APPROVAL_TOKEN_INVALID" });
      throw error;
    }
    this.approvals.delete(token);
    return approval;
  }

  approvalResult(args: RunInput, sessionId: string, reasons: string[]) {
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

  async resolveTarget(step: Pick<Step, "target">, tabId: number, prior: PriorResults, sessionId: string) {
    let target: ResolvedTarget = step.target ?? {};
    if (target.fromStep) {
      const source = prior.get(target.fromStep);
      if (!source) throw new Error(`No result available for step ${target.fromStep}`);
      const candidates = resultCandidates(source);
      target = { ...target, ...record(candidates[target.index ?? 0] ?? source) };
    }
    if (target.query) {
      const prefs = await this.searchPreferences(this.getSession(sessionId));
      const search = await this.invoke("browser_page_search", {
        tabId,
        query: target.query, frameId: target.frameId,
        maxResults: Math.max(prefs.maxResults, (target.index ?? 0) + 1),
        detail: prefs.detail,
        mode: prefs.mode,
      }, sessionId);
      const candidates = resultCandidates(search).filter((candidate) => !target.role || candidate.role === target.role);
      const candidate = candidates[target.index ?? 0];
      if (!candidate) throw new Error(`No page target matched: ${target.query}`);
      target = { ...target, ...candidate, nodeId: candidate.nodeId == null ? undefined : String(candidate.nodeId), selector: candidate.selector ?? undefined, role: candidate.role ?? undefined };
    }
    if (!target.nodeId) target.nodeId = typeof record(target).node_id === "string" ? String(record(target).node_id) : typeof record(target).id === "string" ? String(record(target).id) : undefined;
    return target;
  }

  async searchPreferences(session: RuntimeSession | null = null) {
    const key = session?.profileId ?? "default";
    const cached = this.searchPrefsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const defaults = { maxResults: 5, detail: "lean", mode: "auto" };
    try {
      const status = await this.requestHost("semantic.status", {}, session);
      const settings = record(record(status).settings);
      const value = {
        maxResults: typeof settings.agentResultCount === "number" && Number.isInteger(settings.agentResultCount) ? settings.agentResultCount : defaults.maxResults,
        detail: typeof settings.agentResultDetail === "string" && ["lean", "compact", "debug"].includes(settings.agentResultDetail) ? settings.agentResultDetail : defaults.detail,
        mode: typeof settings.strategyPreference === "string" && ["auto", "semantic", "lexical", "deep"].includes(settings.strategyPreference) ? settings.strategyPreference : defaults.mode,
      };
      this.searchPrefsCache.set(key, { value, expiresAt: Date.now() + 5000 });
      return value;
    } catch {
      return defaults;
    }
  }

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
      truncated: true,
      summary: versionedPayload.summary ?? `${label} was truncated to a useful inline preview; the complete result is optional at artifact.uri`,
      artifact,
    };
  }

  failure(sessionId: string, error: unknown, extra: Record<string, unknown> = {}) {
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

  async run(args: RunInput, context: BrowserContext = {}) {
    let request = { ...args, steps: args.steps ?? [] };
    let sessionId = contextSessionId(args, context);
    let approved = false;
    try {
      if (args.approvalToken) {
        const extraKeys = Object.keys(args).filter((key) => !["approvalToken", "sessionId"].includes(key) && record(args)[key] !== undefined);
        if (extraKeys.length > 0) throw new Error("An approval follow-up must contain only approvalToken");
        const stored = this.takeApproval(args.approvalToken);
        request = { ...stored.request, steps: stored.request.steps ?? [] };
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
      let correctiveCandidate: number | null = null;
      const memoryRequested = request.memoryMode !== "off";
      const memoryState = memoryRequested ? await this.memoryCaptureState(session) : null;
      if (memoryRequested && (request.steps?.length ?? 0) > 0 && !approved) {
        const replay = await this.tryMemoryReplay(request, session, tabId, memoryState);
        if (replay?.used) {
          await this.invoke("browser_turn_end", {}, sessionId).catch(() => {});
          let postObservation;
          if (request.postObserve && session.activeTabId) {
            try { postObservation = await this.observeValue(request.postObserve, session.activeTabId, session); }
            catch (error) { replay.failed = true; postObservation = { ok: false, error: errorDetails(error) }; }
          }
          const mode = request.returnMode ?? "last";
          const selectedResults = mode === "all" ? replay.results : mode === "last" ? replay.results.slice(-1) : replay.results.map(summarizeStepResult);
          return this.compact({
            ok: replay.failed !== true,
            status: replay.failed === true ? "partial" : "memory_replay",
            sessionId,
            profileId: session.profileId,
            tabId: session.activeTabId,
            memory: { used: true, stepsReused: replay.stepsReused, fallback: false },
            summary: replay.failed === true
              ? `Stopped after ${replay.stepsReused} remembered steps to avoid repeating a mutation with uncertain state`
              : `Replayed ${replay.stepsReused} remembered steps`,
            results: selectedResults,
            ...(postObservation ? { observation: postObservation } : {}),
          }, sessionId, clamp(request.maxChars, 4096, 512, 20000), "run");
        }
        correctiveCandidate = replay && !replay.used ? replay.supersedes ?? null : null;
      }
      const prior = new Map();
      const results: RunStepResult[] = [];
      let failed = false;
      const chainId = `${session.sessionId}:${this.memoryChainSequence++}`;
      const memoryEnabled = memoryRequested && this.memoryRecordingEnabled(memoryState);
      try {
        for (const [index, step] of request.steps.entries()) {
          const outcome = await this.executeStepWithPolicy({ step, index, tabId, prior, session, chainId, memoryEnabled });
          if (!outcome.ok) {
            failed = true;
            const detail = outcome.error;
            let observation;
            // Re-reading the page is only worth its bytes when the action may have
            // had an effect and the outcome is genuinely unknown.
            const mayHaveActed = shouldReobservePage({ uncertain: detail.uncertain, readOnly: READ_ACTIONS.has(step.action), hasTarget: Boolean(step.target) });
            if (mayHaveActed && session.activeTabId) {
              observation = await this.observeValue({ mode: "inspect", target: step.target, detail: "lean", limit: 5 }, tabId, session).catch(() => undefined);
            }
            results.push({ index, id: step.id ?? null, action: step.action, ok: false, error: detail, ...(observation ? { observation } : {}) });
            if (step.onError !== "continue") break;
            continue;
          }
          results.push({ index, id: step.id ?? null, action: step.action, ok: true, result: outcome.value, ...(outcome.settled ? { settle: outcome.settled } : {}) });
        }
      } finally {
        if (memoryEnabled) {
          const verified = !failed && results.every(item => record(item.settle).settled !== false);
          await this.requestHost("memory.finalizeChain", { chainId, success: verified, supersedes: verified ? correctiveCandidate : null }, session).catch(() => {});
        }
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
      const selectedResults = mode === "all" ? results : mode === "last" ? results.slice(-1) : results.map(summarizeStepResult);
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

  async observe(args: ObserveInput, context: BrowserContext = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      if (args.mode === "capabilities") {
        const registry = await this.capabilities();
        return { ...contractMetadata(), ok: true, status: "capabilities", sessionId, result: registry.manifest(args.pack ?? "core") };
      }
      if (args.mode === "artifact") {
        const artifact = this.artifacts.read(args.uri ?? "", { sessionId });
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
      if (args.mode === "screenshot" && args.delivery === "inline") {
        return { ...contractMetadata(), ok: true, status: "observed", sessionId, profileId: session.profileId, tabId, result: value };
      }
      const payload = { ok: true, status: "observed", sessionId, profileId: session.profileId, tabId, result: value };
      const inlineValue = args.mode === "raw-snapshot" ? summarizeAccessibilitySnapshot(value, clamp(args.limit, 40, 1, 200)) : value;
      return this.compact(payload, sessionId, clamp(args.maxChars, 4096, 512, 20000), "observe", { ...payload, result: inlineValue });
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async session(args: SessionInput, context: BrowserContext = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      if (args.action === "open") {
        const profiles = await this.connectedProfiles({ fresh: true });
        if (!args.profile && !session.profileId && profiles.length !== 1) {
          const error = new Error(profiles.length > 1 ? "Multiple profiles are connected; pass the user-named profile on open." : "No browser profile is connected.");
          Object.assign(error, { code: profiles.length > 1 ? "PROFILE_SELECTION_REQUIRED" : "NO_BROWSER_PROFILE", profiles: publicProfiles(profiles) });
          throw error;
        }
      }
      const profile = await this.selectProfile(session, args.profile);
      let value = null;
      if (args.action === "open") {
        if (args.name) await this.invoke("browser_name_session", { name: args.name }, sessionId);
        value = await this.invoke("browser_list_tabs", { scope: args.scope ?? "session" }, sessionId);
      } else if (args.action === "configure") {
        const tabId = args.tabId ?? session.activeTabId ?? (await this.invoke("browser_selected_tab", {}, sessionId))?.id;
        if (!tabId) throw new Error("configure requires an active tab or an explicit tabId");
        session.activeTabId = tabId;
        const environment = args.environment ?? {};
        const configuredTabKey = `${session.profileId}:${tabId}`;
        // Track before dispatch so a partially applied or timed-out configure
        // still has a cleanup path. Public state changes only after success.
        if (environment.reset !== true && Object.keys(environment).length) {
          session.configuredTabs.set(configuredTabKey, { tabId, profileId: session.profileId });
        }
        const configured = await this.invoke("browser_configure", { tabId, environment }, sessionId);
        if (environment.reset === true) session.configuredTabs.delete(configuredTabKey);
        session.environment = environment.reset === true ? {} : { ...(session.environment ?? {}), ...environment };
        value = { tabId, environment: session.environment, configured };
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
        const configuredTabKey = `${session.profileId}:${args.tabId}`;
        if (session.configuredTabs.has(configuredTabKey)) {
          await this.invoke("browser_configure", { tabId: args.tabId, environment: { reset: true } }, sessionId);
          session.configuredTabs.delete(configuredTabKey);
        }
        value = await browserRequest("releaseTab", { session_id: sessionId, profile_id: profile.profileId, tabId: args.tabId }, { profileId: profile.profileId });
        if (session.activeTabId === args.tabId) session.activeTabId = null;
      } else if (args.action === "name") {
        if (!args.name) throw new Error("name requires name");
        value = await this.invoke("browser_name_session", { name: args.name }, sessionId);
      }
      return { ...contractMetadata(), ok: true, status: "ready", sessionId, profileId: profile.profileId, activeTabId: session.activeTabId, environment: session.environment ?? {}, result: value };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async finalize(args: FinalizeInput, context: BrowserContext = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const blockedTabs = args.keepEnvironment === true ? [] : await cleanupSessionEnvironment(this, session);
      const result = await this.invoke("browser_finalize", { keep: args.keep ?? [], blockedTabs }, sessionId);
      if (record(result).partial || blockedTabs.length) return { ...contractMetadata(), ok: false, status: "partial", sessionId, result, ...(blockedTabs.length ? { environmentCleanup: blockedTabs } : {}) };
      this.sessions.delete(sessionId);
      this.artifacts.cleanupSession(sessionId);
      return { ...contractMetadata(), ok: true, status: "finalized", sessionId, result };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  // The memory tools must echo the resolved session id, not the raw argument:
  // their output schema requires a string, so returning null when the caller
  // omitted sessionId failed output validation and made every memory tool
  // unusable without an explicit id.
  async memoryStatus(args: MemoryStatusInput = {}, context: BrowserContext = {}) {
    const sessionId = args.sessionId ?? contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const result = await this.requestHost("memory.stats", { profileIds: args.profileIds, includeUnattributed: args.includeUnattributed }, session);
      return { ...contractMetadata(), ok: true, status: "ready", sessionId, result };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async memoryQuery(args: MemoryQueryInput = {}, context: BrowserContext = {}) {
    const sessionId = args.sessionId ?? contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const result = await this.requestHost("memory.query", {
        limit: args.limit,
        capability: args.capability,
        hostname: args.hostname,
        sessionId: args.session_id ?? args.sessionId,
        sinceId: args.since_id,
        untilId: args.until_id,
      }, session);
      return { ...contractMetadata(), ok: true, status: "ready", sessionId, result };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  async memorySearch(args: MemorySearchInput, context: BrowserContext = {}) {
    const sessionId = args.sessionId ?? contextSessionId(args, context);
    try {
      const session = this.getSession(sessionId);
      await this.selectProfile(session, args.profile);
      const result = await this.requestHost("memory.search", {
        query: args.query,
        limit: args.limit,
        kind: args.kind ?? "all",
        hostname: args.hostname,
      }, session);
      return { ...contractMetadata(), ok: true, status: "ready", sessionId, result };
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  close() {
    this.artifacts.close();
    this.sessions.clear();
    this.approvals.clear();
    this.capabilityRegistry = null;
    this.searchPrefsCache.clear();
    closeBrowserClients();
  }
}

export function createAgentBrowserRuntime(options: RuntimeOptions = {}) {
  return new AgentBrowserRuntime(options);
}
