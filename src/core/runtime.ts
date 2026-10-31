import { browserRequest,closeBrowserClients } from "../browser/client.ts";
import { record } from "../shared/values.ts";
import { cleanupSessionEnvironment } from "./environment-cleanup.ts";
import { errorDetails,shouldReobservePage } from "./failure-context.ts";
import { summarizeAccessibilitySnapshot } from './observation-projection.ts';
import type { FinalizeInput,MemoryQueryInput,MemorySearchInput,MemoryStatusInput,ObserveInput,RunInput,SessionInput } from "./registry.ts";
import { requiresApproval,validateSteps } from './run-validation.ts';
import { READ_ACTIONS,clamp,contextSessionId,publicProfiles,summarizeStepResult,type RunStepResult } from "./runtime-foundation.ts";
import { RuntimeMemory } from "./runtime-memory.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import type { BrowserContext } from "./tool-definition.ts";
import { responseMetadata as contractMetadata } from "./versions.ts";

export class AgentBrowserRuntime extends RuntimeMemory {
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
      const authorization = results.map(result => record(record(result).error).authorization).find(Boolean);
      return this.compact({
        ok: !failed,
        status: record(authorization).required === true ? "authorization_required" : failed ? "partial" : "completed",
        sessionId,
        profileId: session.profileId,
        tabId: session.activeTabId,
        summary: `${results.filter((item) => item.ok).length}/${request.steps.length} actions completed`,
        results: selectedResults,
        ...(authorization ? { authorization } : {}),
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
