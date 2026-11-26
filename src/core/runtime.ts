import { browserRequest,closeBrowserClients } from "../browser/client.ts";
import { unsupportedLadybird } from "../browser/ladybird/backend.ts";
import { LADYBIRD_PROFILE } from "../browser/ladybird/config.ts";
import { record } from "../shared/values.ts";
import { prepareTabClaim,type TabClaimApproval } from "./claim-approval.ts";
import { cleanupSessionEnvironment } from "./environment-cleanup.ts";
import { BrowserRuntimeError } from "./errors.ts";
import { shouldReobservePage,stopsBrowserChain } from "./failure-context.ts";
import { summarizeAccessibilitySnapshot } from './observation-projection.ts';
import { fullToolInput } from "./schema-adapters.ts";
import type { FinalizeInput,MemoryQueryInput,MemorySearchInput,MemoryStatusInput,ObserveInput,RunInput,SessionInput,Step } from "./registry.ts";
import { requiresApproval,validateSteps } from './run-validation.ts';
import { READ_ACTIONS,callerSessionId,clamp,contextSessionId,publicProfiles,summarizeStepResult,type RunStepResult,type StepOutcome } from "./runtime-foundation.ts";
import { RuntimeMemory } from "./runtime-memory.ts";
import type { RuntimeOptions,RuntimeSession } from "./runtime-types.ts";
import type { BrowserContext } from "./tool-definition.ts";
import { responseMetadata as contractMetadata } from "./versions.ts";

function stepExtras(outcome: StepOutcome) {
  return { ...(outcome.tabTransition ? { tabTransition: outcome.tabTransition } : {}), ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}) };
}

const UNKNOWN_POST_ACTION_STATE = ". Post-action state is unknown. Check with browser_observe.";

// Every response is re-read by the model for the rest of the conversation, so step results
// drop fields that carry no news: an unnamed id, an unchanged tab, a normal settle.
function leanStepResult(item: RunStepResult) {
  const { id, tabTransition, settle, ...rest } = item;
  const plainSettle = JSON.stringify(settle) === JSON.stringify({ condition: "dom-quiet", settled: true });
  return { ...rest, ...(id ? { id } : {}), ...(tabTransition && tabTransition.kind !== "none" ? { tabTransition } : {}), ...(settle && !plainSettle ? { settle } : {}) };
}

export class AgentBrowserRuntime extends RuntimeMemory {
  async run(args: RunInput, context: BrowserContext = {}) {
    let request = { ...args, steps: args.steps ?? [] };
    let sessionId = contextSessionId(args, context);
    let approved = false;
    try {
      if (args.approvalToken !== undefined) {
        const extraKeys = Object.keys(args).filter((key) => !["approvalToken", "approvalDecision", "sessionId"].includes(key) && record(args)[key] !== undefined);
        if (extraKeys.length > 0) throw new Error("An approval follow-up must contain only approvalToken and an optional decline decision");
        const stored = this.takeApproval(args.approvalToken, args.sessionId, callerSessionId(context));
        sessionId = stored.sessionId;
        if (args.approvalDecision === "decline") {
          if (stored.claim) {
            const { profileId, tab, claimToken } = stored.claim;
            await this.hostRequest("declineTabClaim", { profile_id: profileId, session_id: sessionId, tabId: tab.id, claimToken }, { profileId }).catch(() => {});
          }
          return { ...contractMetadata(), ok: false, status: "approval_declined", sessionId };
        }
        if (stored.claim) {
          const claim = stored.claim, session = this.getSession(sessionId);
          return await this.claimScope.run({ sessionId, profileId: claim.profileId }, async () => {
            const tab = await this.commitTabClaim(session, claim, stored.expiresAt);
            if (!stored.request) return { ...contractMetadata(), ok: true, status: "ready", sessionId, profileId: claim.profileId, activeTabId: tab.id, environment: session.environment ?? {}, result: tab };
            // The chain keeps its approved target if another call changes the session selection.
            const claimed = { ...session, profileId: claim.profileId, activeTabId: tab.id };
            try {
              return await this.runRequest({ ...stored.request, steps: stored.request.steps ?? [] }, sessionId, true, context.deadlineAt, claimed);
            } finally {
              if (session.profileId === claim.profileId && session.activeTabId === tab.id) session.activeTabId = claimed.activeTabId;
            }
          });
        }
        if (!stored.request) throw new Error("Approval requires a browser action");
        request = { ...stored.request, steps: stored.request.steps ?? [] };
        approved = true;
      } else if (args.approvalDecision) {
        throw new Error("An approval decision requires approvalToken");
      }
      validateSteps(request.steps);
      await this.validateCapabilitySteps(request.steps);
      const reasons = requiresApproval(request.steps);
      if (request.tab?.mode === "claim") {
        const { tabId } = request.tab;
        if (!tabId) throw new Error("tab.mode=claim requires tab.tabId");
        if (request.steps.some(step => step.action === "capability" && record(step.input).tabId !== undefined && record(step.input).tabId !== tabId)) {
          throw new Error("A claim action chain must target the selected tab");
        }
        const profile = await this.selectProfile(this.getSession(sessionId), request.profile);
        const claim = await prepareTabClaim(this.hostRequest, profile, sessionId, tabId, this.urlPolicy);
        return this.approvalResult(request, sessionId, ["claim existing tab", ...reasons], claim, callerSessionId(context));
      }
      if (reasons.length > 0 && !approved) return this.approvalResult(request, sessionId, reasons);
      return await this.runRequest(request, sessionId, approved, context.deadlineAt);
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  private async commitTabClaim(session: RuntimeSession, claim: TabClaimApproval, expiresAt: number) {
    if (session.profileId !== claim.profileId) throw new BrowserRuntimeError("The selected profile changed. Request approval in the intended profile.", { code: "TAB_CLAIM_PROFILE_MISMATCH" });
    if (Date.now() >= expiresAt) throw new BrowserRuntimeError("The tab approval expired. Request it again.", { code: "APPROVAL_TOKEN_INVALID" });
    const deadlineAt = Math.min(expiresAt, Date.now() + 10000);
    const result = await this.operationScope.run({ deadlineAt }, () =>
      this.invoke("browser_claim_tab", { profileId: claim.profileId, tabId: claim.tab.id, claimToken: claim.claimToken }, session.sessionId));
    if (result.id !== claim.tab.id) throw new BrowserRuntimeError("The browser returned a different tab after claiming.", { code: "TAB_CLAIM_CHANGED" });
    if (session.profileId === claim.profileId) session.activeTabId = result.id;
    return result;
  }

  private async runRequest(request: RunInput & { steps: Step[] }, sessionId: string, approved: boolean, deadlineAt?: number, claimedSession?: RuntimeSession) {
      const session = claimedSession ?? this.getSession(sessionId);
      if (request.inputMode) session.inputMode = request.inputMode;
      if (request.cursor !== undefined) session.cursor = request.cursor;
      if (!claimedSession) await this.selectProfile(session, request.profile);
      const tabId = claimedSession?.activeTabId ?? await this.ensureTab(session, request.tab);
      let correctiveCandidate: number | null = null;
      const memoryRequested = request.memoryMode !== "off";
      const memoryState = memoryRequested ? await this.memoryCaptureState(session) : null;
      if (memoryRequested && (request.steps?.length ?? 0) > 0 && !approved) {
        const replay = await this.tryMemoryReplay(request, session, tabId, memoryState);
        if (replay?.used) {
          await this.invoke("browser_turn_end", {}, sessionId).catch(() => {});
          const completedMutation = replay.results.every(item => item.ok) && replay.results.some(item => !READ_ACTIONS.has(item.action));
          const observed = !replay.failed && request.postObserve && session.activeTabId
            ? await this.observeAfterRun(request.postObserve, session.activeTabId, session, completedMutation, deadlineAt)
            : undefined;
          const failed = replay.failed === true || observed?.failed === true;
          const summary = replay.failed === true
            ? `Stopped after ${replay.stepsReused} remembered steps to avoid repeating a mutation with uncertain state`
            : `Replayed ${replay.stepsReused} remembered steps`;
          const mode = request.returnMode ?? "last";
          const selectedResults = mode === "all" ? replay.results : mode === "last" ? replay.results.slice(-1) : replay.results.map(summarizeStepResult);
          return this.compact({
            ok: !failed,
            status: failed ? "partial" : "memory_replay",
            sessionId,
            profileId: session.profileId,
            tabId: session.activeTabId,
            memory: { used: true, stepsReused: replay.stepsReused, fallback: false },
            summary: summary + (observed?.stateUnknown ? UNKNOWN_POST_ACTION_STATE : ""),
            results: selectedResults,
            ...(replay.results.some(item => item.warnings?.length) ? { warnings: replay.results.flatMap(item => item.warnings ?? []).slice(0, 1) } : {}),
            ...(observed?.value !== undefined ? { observation: observed.value } : {}),
          }, sessionId, clamp(request.maxChars, 4096, 512, 20000), "run");
        }
        correctiveCandidate = replay && !replay.used ? replay.supersedes ?? null : null;
      }
      const prior = new Map();
      const results: RunStepResult[] = [];
      let failed = false;
      let stopped = false;
      const chainId = `${session.sessionId}:${this.memoryChainSequence++}`;
      const memoryEnabled = memoryRequested && this.memoryRecordingEnabled(memoryState);
      try {
        for (const [index, step] of request.steps.entries()) {
          const outcome = await this.executeStepWithPolicy({ step, index, tabId, prior, session, chainId, memoryEnabled, patternGrant: memoryState?.patternGrant });
          stopped = Boolean(outcome.warnings?.some(stopsBrowserChain)) || (!outcome.ok && stopsBrowserChain(outcome.rawError));
          if (!outcome.ok) {
            failed = true;
            const detail = outcome.error;
            let observation;
            // Re-reading the page is only worth its bytes when the action may have
            // had an effect and the outcome is genuinely unknown.
            const mayHaveActed = shouldReobservePage({ uncertain: detail.uncertain, readOnly: READ_ACTIONS.has(step.action), hasTarget: Boolean(step.target) });
            if (!stopped && mayHaveActed && session.activeTabId) {
              observation = await this.observeValue({ mode: "inspect", target: step.target, detail: "lean", limit: 5 }, tabId, session).catch(() => undefined);
            }
            results.push({ index, id: step.id ?? null, action: step.action, ok: false, error: detail, ...(observation ? { observation } : {}), ...stepExtras(outcome) });
            if (stopped || detail.uncertain || step.onError !== "continue") { stopped ||= detail.uncertain; break; }
            continue;
          }
          results.push({ index, id: step.id ?? null, action: step.action, ok: true, result: outcome.value, ...(outcome.settled ? { settle: outcome.settled } : {}), ...stepExtras(outcome) });
          if (stopped) { failed ||= index + 1 < request.steps.length; break; }
        }
      } finally {
        if (memoryEnabled) {
          const verified = !failed && !stopped && results.every(item => record(item.settle).settled !== false);
          await this.requestHost("memory.finalizeChain", { chainId, success: verified, supersedes: verified ? correctiveCandidate : null }, session).catch(() => {});
        }
        await this.invoke("browser_turn_end", {}, sessionId).catch(() => {});
      }
      let postObservation;
      let stateUnknown = false;
      if (!stopped && request.postObserve && session.activeTabId) {
        const completedMutation = !failed && results.some(item => item.ok && !READ_ACTIONS.has(item.action));
        const observed = await this.observeAfterRun(request.postObserve, session.activeTabId, session, completedMutation, deadlineAt);
        postObservation = observed.value;
        stateUnknown = observed.stateUnknown;
        failed ||= observed.failed;
      } else if (!stopped && session.activeTabId && request.steps.some(step => !READ_ACTIONS.has(step.action)) && await this.isGuardedTab(session.activeTabId, session)) {
        // On a guarded host the agent gets the script-free change summary for free,
        // so it never needs a screenshot to see what its action did.
        postObservation = await this.readView(session.activeTabId, session, {}).catch(() => undefined);
      }
      const mode = request.returnMode ?? "last";
      const selectedResults = (mode === "all" ? results : mode === "last" ? results.slice(-1) : results.map(summarizeStepResult)).map(leanStepResult);
      const authorization = results.map(result => record(result.error).authorization).find(Boolean);
      const warnings = [...new Map(results.flatMap(result => result.warnings ?? []).map(warning => [warning.code, warning])).values()];
      return this.compact({
        ok: !failed,
        status: record(authorization).required === true ? "authorization_required" : failed ? "partial" : "completed",
        sessionId,
        profileId: session.profileId,
        tabId: session.activeTabId,
        summary: `${results.filter((item) => item.ok).length}/${request.steps.length} actions completed` + (stateUnknown ? UNKNOWN_POST_ACTION_STATE : ""),
        results: selectedResults,
        ...(warnings.length ? { warnings } : {}),
        ...(authorization ? { authorization } : {}),
        ...(postObservation !== undefined ? { observation: postObservation } : {}),
      }, sessionId, clamp(request.maxChars, 4096, 512, 20000), "run");
  }

  async observe(args: ObserveInput, context: BrowserContext = {}) {
    const sessionId = contextSessionId(args, context);
    try {
      if (args.mode === "capabilities") {
        if (args.pack === "schema")
          return this.compact({ ok: true, status: "capabilities", sessionId, result: fullToolInput(args.query) }, sessionId, 4000, "tool-schema");
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
      const tabId = args.tabId === undefined
        ? session.activeTabId ?? (await this.invoke("browser_selected_tab", {}, sessionId))?.id
        : await this.selectExplicitTab(session, args.tabId);
      if (!tabId) throw new Error("No controlled tab is selected. Create or claim one with browser_session.");
      session.activeTabId = tabId;
      const value = await this.observeWithMemory(args, tabId, session);
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
        if (profile.experimental) value = { ...record(value), profileLabel: profile.profileLabel, experimental: true };
      } else if (args.action === "configure") {
        const tabId = args.tabId ?? session.activeTabId ?? (await this.invoke("browser_selected_tab", {}, sessionId))?.id;
        if (!tabId) throw new Error("configure requires an active tab or an explicit tabId");
        const environment = args.environment ?? {};
        const configuredTabKey = `${session.profileId}:${tabId}`;
        // Track before dispatch so a partially applied or timed-out configure
        // still has a cleanup path. Public state changes only after success.
        if (environment.reset !== true && Object.keys(environment).length) {
          session.configuredTabs.set(configuredTabKey, { tabId, profileId: session.profileId });
        }
        const configured = await this.invoke("browser_configure", { tabId, environment }, sessionId);
        session.activeTabId = tabId;
        if (environment.reset === true) session.configuredTabs.delete(configuredTabKey);
        session.environment = environment.reset === true ? {} : { ...(session.environment ?? {}), ...environment };
        value = { tabId, environment: session.environment, configured };
      } else if (args.action === "new-tab") {
        const tab = await this.invoke("browser_new_tab", {}, sessionId);
        session.activeTabId = tab.id ?? tab.tabId;
        value = tab;
      } else if (args.action === "claim-tab") {
        if (!args.tabId) throw new Error("claim-tab requires tabId");
        const claim = await prepareTabClaim(this.hostRequest, profile, sessionId, args.tabId, this.urlPolicy);
        return this.approvalResult(null, sessionId, ["claim existing tab"], claim, callerSessionId(context));
      } else if (args.action === "release-tab") {
        if (!args.tabId) throw new Error("release-tab requires tabId");
        if (profile.profileId === LADYBIRD_PROFILE) throw unsupportedLadybird("releasing tabs for human review");
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
      // A session still owns its disposable browser if its on-disk driver
      // configuration was removed after launch.
      if (session.profileId !== LADYBIRD_PROFILE || args.profile) await this.selectProfile(session, args.profile);
      const blockedTabs = args.keepEnvironment === true ? [] : await cleanupSessionEnvironment(this, session);
      const keep = (args.keep ?? []).map(item => {
        if (!args.profile || !session.profileId) return item;
        return typeof item === "number" ? { tabId: item, profileId: session.profileId } : { profileId: session.profileId, ...item };
      });
      const result = await this.invoke("browser_finalize", { keep, blockedTabs }, sessionId);
      if (record(result).partial || blockedTabs.length) return { ...contractMetadata(), ok: false, status: "partial", sessionId, result, ...(blockedTabs.length ? { environmentCleanup: blockedTabs } : {}) };
      for (const [token, approval] of this.approvals) if (approval.claim && approval.sessionId === sessionId) this.approvals.delete(token);
      const profiles = record(record(result).profiles);
      const handedOff = Object.values(profiles).some(profile => {
        const tabs = record(profile).tabs;
        return Array.isArray(tabs) && tabs.some(tab => record(tab).status === "kept");
      });
      if (!handedOff) {
        this.sessions.delete(sessionId);
        this.artifacts.cleanupSession(sessionId);
      } else {
        const selected = record(profiles[session.profileId ?? ""]).tabs;
        if (Array.isArray(selected) && !selected.some(tab => record(tab).status === "kept" && record(tab).tabId === session.activeTabId)) session.activeTabId = null;
      }
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
    return this.ladybird.close();
  }
}
export function createAgentBrowserRuntime(options: RuntimeOptions = {}) {
  return new AgentBrowserRuntime(options);
}
