import { t } from "../../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, formatBytes, memoryCall, MB, type MemoryStatus, type MemoryProfiles } from "./api";

const EMPTY_COUNTS: MemoryStatus["counts"] = {
  signatures: 0,
  chains: 0,
  failure_contexts: 0,
  confirmed_total: 0,
  failed_total: 0,
};

// Replay is skipped silently by design, so the dashboard has to name the
// reason: "replay success —" and "replays 0" are indistinguishable from a
// feature that is simply not wired up. Legacy reasons from older hosts stay
// mapped so historical rows keep reading correctly.
const REPLAY_SKIP_LABELS: Record<string, string> = {
  below_similarity: t("skipNoMatch"),
  below_confidence: t("skipNoMatch"),
  negative_lesson: t("skipPriorFailure"),
  step_count_mismatch: t("skipSteps"),
  recipe_mismatch: t("skipRecipe"),
  hostname_mismatch: t("skipSite"),
  action_mismatch: t("skipActions"),
  target_mismatch: t("skipTargets"),
  missing_runtime_value: t("skipValue"),
  missing_runtime_url: t("skipUrl"),
  approval_required: t("skipApproval"),
};

function dominantSkipReason(reasons: Record<string, number> | undefined): [string, number] | null {
  if (!reasons) return null;
  let best: [string, number] | null = null;
  for (const [reason, count] of Object.entries(reasons)) {
    if (!best || count > best[1]) best = [reason, count];
  }
  return best;
}

function MemoryChart({ daily }: { daily: MemoryStatus["recent_daily"] }): React.JSX.Element | null {
  const days = (Array.isArray(daily) ? daily : []).slice(-14);
  if (days.length === 0 || !days.some((day) => day.confirmed + day.failed > 0)) return null;

  const width = 320;
  const height = 64;
  const pad = 14;
  const maxValue = Math.max(1, ...days.map((day) => day.confirmed + day.failed));
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad;
  const barWidth = Math.min(12, (plotWidth / Math.max(1, days.length)) * 0.6);

  return (
    <div className="memory-chart" aria-label={t("chartLabel")}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {days.map((day, index) => {
          const x = pad + (index / Math.max(1, days.length - 1)) * plotWidth;
          const failed = (day.failed / maxValue) * plotHeight;
          const confirmed = (day.confirmed / maxValue) * plotHeight;
          return (
            <g key={`${index}-${day.confirmed}-${day.failed}`}>
              {day.failed > 0 && (
                <rect x={x - barWidth / 2} y={pad + plotHeight - failed} width={barWidth} height={failed} fill="var(--bad)" opacity="0.7" />
              )}
              {day.confirmed > 0 && (
                <rect x={x - barWidth / 2} y={pad + plotHeight - failed - confirmed} width={barWidth} height={confirmed} fill="var(--ok)" rx="1" />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function MemoryView({ view = "overview" }: { view?: "overview" | "settings" }): React.JSX.Element {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryFeedback, setMemoryFeedback] = useState("");
  const [quotaValue, setQuotaValue] = useState(100);
  const [purgeDays, setPurgeDays] = useState(7);
  const [profiles, setProfiles] = useState<MemoryProfiles | null>(null);
  const [scope, setScope] = useState("current");
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const requestId = useRef(0);
  const dirty = useRef({ quota: false, purge: false });
  const quotaTimer = useRef<number | null>(null);

  const refreshMemory = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const known = await memoryCall<MemoryProfiles>("memory.profiles").catch(() => null);
      if (id !== requestId.current) return;
      setProfiles(known);
      const profileIds = scope === "all" ? null : scope === "current" ? known?.currentProfileId ? [known.currentProfileId] : null : scope === "unknown" ? [] : selectedProfiles;
      const next = await memoryCall<MemoryStatus>("memory.stats", { profileIds, includeUnattributed: scope === "unknown" });
      if (id !== requestId.current) return;
      if (next.supported === false) throw new Error(t("memorySqlite"));
      setStatus(next);
      setLoadError("");
      if (!dirty.current.quota) setQuotaValue(Math.round(next.quota_bytes / MB));
      if (!dirty.current.purge) setPurgeDays(next.purge_days);
    } catch (error) {
      if (id === requestId.current) setLoadError(errorMessage(error));
    }
  }, [scope, selectedProfiles]);

  useEffect(() => {
    let disposed = false;
    let timer: number;
    const poll = async () => {
      if (document.visibilityState === "visible") await refreshMemory();
      if (!disposed) timer = window.setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      disposed = true;
      ++requestId.current;
      window.clearTimeout(timer);
    };
  }, [refreshMemory]);

  useEffect(() => () => {
    if (quotaTimer.current !== null) window.clearTimeout(quotaTimer.current);
  }, []);

  const runMemoryAction = useCallback(async (method: string, successText: string) => {
    if (memoryBusy) return;
    setMemoryBusy(true);
    try {
      await memoryCall(method);
      setMemoryFeedback(successText);
    } catch (error) {
      setMemoryFeedback(errorMessage(error));
    } finally {
      setMemoryBusy(false);
      await refreshMemory();
    }
  }, [memoryBusy, refreshMemory]);

  const updateConfig = useCallback(async (params: object, successText: string) => {
    setMemoryBusy(true);
    try {
      await memoryCall("memory.configure", params);
      dirty.current = { quota: false, purge: false };
      setMemoryFeedback(successText);
    } catch (error) {
      setMemoryFeedback(errorMessage(error));
    } finally {
      setMemoryBusy(false);
      await refreshMemory();
    }
  }, [refreshMemory]);

  const queueQuotaUpdate = (value: number) => {
    dirty.current.quota = true;
    setQuotaValue(value);
    if (quotaTimer.current !== null) window.clearTimeout(quotaTimer.current);
    quotaTimer.current = window.setTimeout(() => {
      void updateConfig({ quota_bytes: value * MB }, t("dbLimitSet", formatBytes(value * MB)));
    }, 300);
  };

  const counts = status?.counts ?? EMPTY_COUNTS;
  const usage = status?.usage;
  const v2Actions = counts.actions_v2 ?? counts.signatures;
  const v2Chains = counts.chains_v2 ?? counts.chains;
  const unindexed = (counts.unindexed_actions ?? 0) + (counts.unindexed_chains ?? 0);
  const indexed = Math.max(0, v2Actions + v2Chains - unindexed);
  const replayRate = usage?.replay_success_rate ?? null;
  const replayAttempts = usage?.replay_attempts ?? 0;
  const quotaBytes = status?.quota_bytes ?? 100 * MB;
  const bytesUsed = status?.bytes_used ?? 0;
  const quotaFill = Math.min(100, (bytesUsed / Math.max(1, quotaBytes)) * 100);
  const enabled = status?.enabled === true;
  const powerUser = status?.power_user === true;
  const executions = counts.executions_v2 ?? 0;
  const negativeActions = counts.negative_actions_v2 ?? 0;
  const stateLine = status
    ? enabled
      ? t("memoryCounts", [String(v2Actions), String(v2Chains)])
      : t("enableStartMemory")
    : t("memoryStateChecking");

  const stats = useMemo(() => [
    ["memory-success", replayRate === null ? "—" : `${replayRate}%`, t("replaySuccess")],
    ["memory-actions", v2Actions, t("uniqueActions")],
    ["memory-chains", v2Chains, t("recipes")],
    ["memory-replays", replayAttempts, t("replays")],
    ["memory-steps-reused", usage?.steps_reused ?? 0, t("stepsReused")],
  ] as const, [v2Actions, v2Chains, replayRate, replayAttempts, usage?.steps_reused]);

  const secondaryStats = useMemo(() => [
    ["memory-executions", executions, t("executions")],
    ["memory-negatives", negativeActions, t("negativeLessons")],
    ["memory-indexed", indexed, t("indexed")],
    ["memory-awaiting", unindexed, unindexed === 1 ? t("awaitingIndex") : t("awaitingIndex")],
  ] as const, [executions, negativeActions, indexed, unindexed]);

  const healthLine = useMemo(() => {
    if (!status) return "";
    if (status.health === "embedding_errors") return t("embeddingErrors", status.last_embedding_error ?? t("modelUnknown"));
    if (unindexed > 0) return t("memoryIndexPending", [String(indexed), String(unindexed)]);
    return t("memoryIndexReady", String(indexed));
  }, [status, indexed, unindexed]);

  const replayLine = useMemo(() => {
    if (!status || !enabled) return "";
    const skipped = usage?.replay_rejections ?? usage?.replay_fallbacks ?? 0;
    if (skipped > 0) {
      const dominant = dominantSkipReason(usage?.replay_rejections_by_reason);
      if (!dominant) return t("skipCount", String(skipped));
      const label = REPLAY_SKIP_LABELS[dominant[0]] ?? dominant[0];
      return t("skipCountReason", [String(skipped), label, String(dominant[1])]);
    }
    if (replayAttempts === 0 && v2Chains > 0) return t("replayNotAttempted");
    return "";
  }, [status, enabled, usage?.replay_fallbacks, usage?.replay_rejections, usage?.replay_rejections_by_reason, replayAttempts, v2Chains]);

  return (
    <section id="view-memory" className="view">
      {view === "settings" ? <>
      <div className="card memory-card memory-control-card">
        <div className="memory-head">
          <div>
            <h2>{t("actionMemory")}</h2>
            <span className="memory-state-line">{t("memoryDescription")}</span>
          </div>
        </div>
        <span id="memory-state-line" className="visually-hidden" aria-live="polite">{stateLine}</span>
        <div className="memory-actions memory-toggle-actions">
          <button id="memory-enable" className="button button-primary" type="button" disabled={!status || memoryBusy || enabled} onClick={() => void runMemoryAction("memory.enable", t("memoryEnabled"))}>{t("enableMemory")}</button>
          <button id="memory-disable" className="button" type="button" disabled={!status || memoryBusy || !enabled} onClick={() => void runMemoryAction("memory.disable", t("memoryDisabled"))}>{t("disableMemory")}</button>
        </div>
      </div>

      <details className="card memory-card memory-settings-details">
        <summary>{t("storageLimit")}</summary>
        <div className="memory-head">
          <div>
            <h2 id="quota-heading">{t("storageLimit")}</h2>
            <span id="quota-caption" className="memory-state-line">
              {powerUser ? t("expandedEnabled") : t("standardLimit")}
            </span>
          </div>
          <span id="quota-now" className="quota-now">{formatBytes(quotaBytes)}</span>
        </div>
        <input
          id="quota-slider"
          aria-labelledby="quota-heading"
          aria-describedby="quota-caption quota-now"
          className="quota-slider"
          type="range"
          min="100"
          max="10240"
          step="100"
          value={quotaValue}
          disabled={!status || memoryBusy || !powerUser}
          onChange={(event) => queueQuotaUpdate(Number(event.target.value))}
        />
        <div className="quota-scale"><span>100 MB</span><span>2.5 GB</span><span>5 GB</span><span>10 GB</span></div>
        <label className="checkbox-row power-row">
          <input id="power-user" type="checkbox" checked={powerUser} disabled={!status || memoryBusy} onChange={(event) => void updateConfig({ power_user: event.target.checked }, event.target.checked ? t("storageExpanded") : t("storageStandard"))} />
          <span>{t("expandedStorage")}</span>
        </label>
        {powerUser && <p id="power-note" className="help-note">{t("expandedStorageHelp")}</p>}
        <div className="quota-track"><div id="quota-fill" className="quota-fill" style={{ width: `${quotaFill}%` }} /></div>
        <p id="quota-usage" className="help-note">{t("quotaUsage", [formatBytes(bytesUsed), formatBytes(quotaBytes)])}</p>
      </details>

      <details className="card memory-card memory-settings-details">
        <summary>{t("cleanup")}</summary>
        <div className="memory-head">
          <div>
            <h2>{t("cleanup")}</h2>
            <span className="memory-state-line">{t("cleanupHelp")}</span>
          </div>
        </div>
        <div className="memory-actions">
          <label className="purge-label" htmlFor="purge-days">{t("removeAfter")}</label>
          <input id="purge-days" className="purge-days" type="number" min="1" max="365" value={purgeDays} disabled={!status || memoryBusy} onChange={(event) => { dirty.current.purge = true; setPurgeDays(Number(event.target.value)); }} onBlur={() => {
            if (Number.isInteger(purgeDays) && purgeDays >= 1 && purgeDays <= 365) void updateConfig({ purge_days: purgeDays }, t("purgeAfter", String(purgeDays)));
            else setMemoryFeedback(t("purgeInvalid"));
          }} />
          <span className="purge-unit">{t("days")}</span>
          <button id="prune-now" className="button" type="button" disabled={!status || memoryBusy} onClick={() => void runMemoryAction("memory.prune", t("cleanupComplete"))}>{t("cleanupNow")}</button>
        </div>
      </details>

      </> : <div className="card memory-card">
        <div className="memory-head">
          <div>
            <h2>{t("replayMemory")}</h2>
            <span className="memory-state-line">{t("memoryStatsHelp")}</span>
          </div>
        </div>
        <p className="help-note">{loadError ? t("memoryUnavailable") : !status ? t("memoryChecking") : enabled ? t("memoryOn") : t("memoryOff")}</p>
        <details className="usage-details"><summary>{t("activityStats")}</summary>
        <label className="field-label" htmlFor="statistics-scope">{t("showActivity")}</label>
        <select id="statistics-scope" value={scope} disabled={!profiles || !status?.capabilities?.profileStatistics} onChange={(event) => { ++requestId.current; setStatus(null); setScope(event.target.value); }}>
          <option value="current">{t("thisProfile")}</option>
          <option value="all">{t("allProfiles")}</option>
          <option value="selected">{t("selectedProfiles")}</option>
          <option value="unknown">{t("oldActivity")}</option>
        </select>
        {scope === "selected" ? <fieldset className="profile-options"><legend>{t("profilesInclude")}</legend>{profiles?.profiles.map((profile, index) => <label className="checkbox-row" key={profile.profileId}><input type="checkbox" checked={selectedProfiles.includes(profile.profileId)} onChange={(event) => { ++requestId.current; setStatus(null); setSelectedProfiles((previous) => event.target.checked ? [...previous, profile.profileId] : previous.filter((id) => id !== profile.profileId)); }} />{profile.profileLabel || profile.browserName || t("profileNumber", String(index + 1))}{profile.profileId === profiles.currentProfileId ? t("thisProfileSuffix") : ""}</label>)}</fieldset> : null}
        <p className="help-note">{!status ? t("loadingStats") : !status.capabilities?.profileStatistics || !profiles ? t("hostTotals") : scope === "current" ? t("currentProfileValue", profiles.profiles.find((item) => item.profileId === profiles.currentProfileId)?.profileLabel || t("currentBrowserProfile")) : scope === "selected" ? t("selectedCount", String(selectedProfiles.length)) : scope === "unknown" ? t("oldHistory") : t("allHistory")}</p>
        <dl className="decision-usage memory-usage">
          {[...stats, ...secondaryStats].map(([id, value, label]) => <div key={id}><dt>{label}</dt><dd id={id}>{status ? value : "—"}</dd></div>)}
        </dl>
        <p id="memory-health" className="help-note">{healthLine}</p>
        {replayLine ? <p id="memory-replay-note" className="help-note">{replayLine}</p> : null}
        <div className="memory-actions">
          <button id="memory-reindex" className="button" type="button" disabled={!status || memoryBusy || !enabled} onClick={() => void runMemoryAction("memory.reindex", t("indexRebuilt"))}>{t("rebuildIndex")}</button>
        </div>
        <MemoryChart daily={status?.recent_daily} />
        <p className="help-note">{status?.observedAt ? t("statsUpdated", new Date(status.observedAt).toLocaleTimeString()) : t("waitingStats")}</p>
        </details>
      </div>}
      <p id="memory-feedback" className="feedback" role="status">{memoryFeedback}</p>
      {loadError ? <p className="feedback" role="alert">{t("statsUnavailable")}{" "}{loadError}{status ? t("lastSuccessful") : ""}</p> : null}
    </section>
  );
}
