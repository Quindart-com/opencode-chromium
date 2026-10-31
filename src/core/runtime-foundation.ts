import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { browserRequest,listBrowserProfiles } from "../browser/client.ts";
import { createFilePolicy,filePolicyFromEnv } from "../browser/file-policy.ts";
import type { BrowserOperation } from "../browser/operation-definition.ts";
import { createBrowserOperations } from "../browser/operations/index.ts";
import { nodeFrameId } from "../browser/operations/page-state.ts";
import { assertNavigationAllowed,combineUrlPolicyConfig,createUrlPolicy,urlPolicyFromEnv } from "../browser/url-policy.ts";
import { authorizationQuestion } from "../shared/authorization.ts";
import { recipeSchema,type RecipeStep } from "../shared/memory-recipe.ts";
import { record } from "../shared/values.ts";
import { ArtifactStore } from "./artifacts.ts";
import { createCapabilityRegistry } from "./capabilities.ts";
import { BrowserRuntimeError,errorMessage } from "./errors.ts";
import { errorDetails } from "./failure-context.ts";
import { createLogger } from "./logging.ts";
import { createObservationOperations } from "./observation-diffs.ts";
import { candidateSchema,parseOperationResult,type OperationResult } from "./operation-results.ts";
import type { BrowserProfile } from "./profiles.ts";
import { selectProfile as selectConnectedProfile } from "./profiles.ts";
import type { RunInput,Step,Target } from "./registry.ts";
import { runInputSchema } from "./registry.ts";
import type { PendingApproval,RuntimeOptions,RuntimeSession,SearchPreferences } from "./runtime-types.ts";
import type { BrowserContext } from "./tool-definition.ts";
import { responseMetadata as contractMetadata } from "./versions.ts";

export type PriorResults = Map<string, unknown>;
export type ResolvedTarget = Target & { node_id?: string | number | null; id?: string | number | null };
export type MemoryCapture = { enabled: boolean; paused: boolean; embedding_profile?: string | null };
export const memoryMatchSchema = z.looseObject({ id: z.number().optional(), kind: z.string(), steps: z.array(recipeSchema), embedding_profile: z.string().nullable().optional(), confidence: z.number().optional(), similarity: z.number().optional(), deterministic: z.boolean().optional(), failed_count: z.number().optional() });
export type RunStepResult = { index: number; action: Step["action"]; id?: string | null; ok: boolean; result?: unknown; error?: ReturnType<typeof errorDetails>; settle?: unknown; observation?: unknown };
export function summarizeStepResult(item: RunStepResult) { const { result, ...rest } = item; const value = record(result); return { ...rest, ...(value.screenshot ? { artifact: value.screenshot } : value.artifact ? { artifact: value.artifact } : {}) }; }
export type StepOutcome = { ok: true; value: unknown; settled: unknown; executionState: string } | { ok: false; error: ReturnType<typeof errorDetails>; rawError: unknown; value: unknown; settled: unknown; executionState: string };
export type ReplayOutcome = { used: true; stepsReused: number; results: RunStepResult[]; failed?: boolean } | { used?: false; fallback: true; supersedes?: number | null } | null;
export type StepExecution = { step: Step; index: number; tabId: number; prior: PriorResults; session: RuntimeSession; chainId: string; memoryEnabled: boolean };
export type ScreenshotOptions = { fullPage?: boolean; format?: "png" | "jpeg" | "webp"; quality?: number; timeoutMs?: number; delivery?: "artifact" | "inline" };
export type ResultPayload = Record<string, unknown> & { ok: boolean; status: string; sessionId: string; summary?: string };
export const APPROVAL_TTL_MS = 5 * 60 * 1000;
export const READ_ACTIONS = new Set(["find", "hover", "assert", "screenshot", "clipboardRead"]);
export const READ_LEGACY_TOOLS = new Set([
  "browser_page_search", "browser_page_inspect", "browser_visual_map", "browser_dom_snapshot",
  "browser_locator_count", "browser_locator_text", "browser_console_logs", "browser_network_events",
  "browser_network_inspect", "browser_download_events", "browser_snapshot", "browser_selected_tab", "browser_list_tabs",
]);

export function parseLegacyResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

export function isStaleTargetError(error: unknown) {
  return /stale|detached|unknown node|node.+not found|no element.+node/i.test(errorMessage(error));
}

export function cloneRequest(value: RunInput): RunInput {
  return runInputSchema.parse(JSON.parse(JSON.stringify(value)) as unknown);
}

export function contextSessionId(args: { sessionId?: string | null }, context: BrowserContext) {
  return args.sessionId
    ?? context?.sessionId
    ?? context?.sessionID
    ?? context?.session_id
    ?? `browser-${randomUUID()}`;
}

export function resultCandidates(value: unknown): z.infer<typeof candidateSchema>[] {
  if (!value || typeof value !== "object") return [];
  for (const key of ["results", "matches", "units", "items", "elements"]) {
    if (Array.isArray(record(value)[key])) return (record(value)[key] as unknown[]).flatMap(value => { const parsed = candidateSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  }
  return [];
}

export function usesLongSearchTimeout(strategy: string) {
  return ["deep", "semantic", "snowflake"].includes(strategy);
}

export function normalizedTargetText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLocaleLowerCase() : null;
}

export function rememberedStepMismatch(remembered: RecipeStep, source: Step | undefined, hostname: string | null) {
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

export function publicProfiles(profiles: BrowserProfile[]) {
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

export class RuntimeFoundation {
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
      authorization: authorizationQuestion("browser-action"),
      instruction: "If approval is missing, ask the user Approve / Disapprove with the harness question tool. After approval, call browser_run with only approvalToken. No browser action has run yet.",
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
}
