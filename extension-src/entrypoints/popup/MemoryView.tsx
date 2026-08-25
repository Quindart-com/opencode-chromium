import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, formatBytes, memoryCall, MB, type MemoryStatus } from "./api";

const EMPTY_COUNTS: MemoryStatus["counts"] = {
  signatures: 0,
  chains: 0,
  failure_contexts: 0,
  confirmed_total: 0,
  failed_total: 0,
};

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
    <div className="memory-chart" aria-label="Confirmed versus failed actions per day">
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

export default function MemoryView(): React.JSX.Element {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryFeedback, setMemoryFeedback] = useState("");
  const [shareFeedback, setShareFeedback] = useState("");
  const [quotaValue, setQuotaValue] = useState(100);
  const [purgeDays, setPurgeDays] = useState(7);
  const quotaTimer = useRef<number | null>(null);

  const refreshMemory = useCallback(async () => {
    try {
      const next = await memoryCall<MemoryStatus>("memory.stats");
      setStatus(next);
      setQuotaValue(Math.round(next.quota_bytes / MB));
      setPurgeDays(next.purge_days);
    } catch (error) {
      setMemoryFeedback(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshMemory();
    return () => {
      if (quotaTimer.current !== null) window.clearTimeout(quotaTimer.current);
    };
  }, [refreshMemory]);

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
      setMemoryFeedback(successText);
    } catch (error) {
      setMemoryFeedback(errorMessage(error));
    } finally {
      setMemoryBusy(false);
      await refreshMemory();
    }
  }, [refreshMemory]);

  const queueQuotaUpdate = (value: number) => {
    setQuotaValue(value);
    if (quotaTimer.current !== null) window.clearTimeout(quotaTimer.current);
    quotaTimer.current = window.setTimeout(() => {
      void updateConfig({ quota_bytes: value * MB }, `Database limit set to ${formatBytes(value * MB)}.`);
    }, 300);
  };

  const counts = status?.counts ?? EMPTY_COUNTS;
  const total = counts.confirmed_total + counts.failed_total;
  const successRate = total > 0 ? Math.round((counts.confirmed_total / total) * 100) : 100;
  const quotaBytes = status?.quota_bytes ?? 100 * MB;
  const bytesUsed = status?.bytes_used ?? 0;
  const quotaFill = Math.min(100, (bytesUsed / Math.max(1, quotaBytes)) * 100);
  const enabled = status?.enabled === true;
  const powerUser = status?.power_user === true;
  const stateLine = status
    ? enabled
      ? `${counts.signatures} actions, ${counts.chains} chains, ${counts.failure_contexts} negative lessons.`
      : "Enable it to start building action memory."
    : "Checking memory state...";

  const stats = useMemo(() => [
    ["memory-success", `${successRate}%`, "success rate"],
    ["memory-actions", counts.signatures, "actions"],
    ["memory-chains", counts.chains, "chains"],
    ["memory-negatives", counts.failure_contexts, "lessons"],
    ["memory-hits", status?.memory_hits ?? 0, "hits"],
  ] as const, [counts, status?.memory_hits, successRate]);

  return (
    <section id="view-memory" className="view">
      <div className="card memory-card memory-control-card">
        <div className="memory-head">
          <div>
            <h2>Action memory</h2>
            <span className="memory-state-line">Save successful browser actions locally to speed up repeat tasks.</span>
          </div>
        </div>
        <span id="memory-state-line" className="visually-hidden" aria-live="polite">{stateLine}</span>
        <div className="memory-actions memory-toggle-actions">
          <button id="memory-enable" className="button button-success" type="button" disabled={!status || memoryBusy || enabled} onClick={() => void runMemoryAction("memory.enable", "Action memory enabled.")}>Enable</button>
          <button id="memory-disable" className="button button-danger" type="button" disabled={!status || memoryBusy || !enabled} onClick={() => void runMemoryAction("memory.disable", "Action memory disabled.")}>Disable</button>
        </div>
        <p id="memory-feedback" className="feedback" role="status">{memoryFeedback}</p>
      </div>

      <div className="card memory-card">
        <div className="memory-head">
          <div>
            <h2>Storage limit</h2>
            <span id="quota-caption" className="memory-state-line">
              {powerUser ? "Expanded storage enabled — up to 10 GB." : "Standard limit. Turn on expanded storage to raise it."}
            </span>
          </div>
          <span id="quota-now" className="quota-now">{formatBytes(quotaBytes)}</span>
        </div>
        <input
          id="quota-slider"
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
          <input id="power-user" type="checkbox" checked={powerUser} disabled={!status || memoryBusy} onChange={(event) => void updateConfig({ power_user: event.target.checked }, event.target.checked ? "Expanded storage enabled — the limit can now reach 10 GB." : "Expanded storage disabled — the standard limit is restored.")} />
          <span>Expanded storage — allow up to 10 GB</span>
        </label>
        {powerUser && <p id="power-note" className="help-note">Expanded storage can use more disk space.</p>}
        <div className="quota-track"><div id="quota-fill" className="quota-fill" style={{ width: `${quotaFill}%` }} /></div>
        <p id="quota-usage" className="help-note">{formatBytes(bytesUsed)} of {formatBytes(quotaBytes)} used</p>
      </div>

      <div className="card memory-card">
        <div className="memory-head">
          <div>
            <h2>Cleanup</h2>
            <span className="memory-state-line">Unsuccessful actions age out automatically. Confirmed actions remain.</span>
          </div>
        </div>
        <div className="memory-actions">
          <label className="purge-label" htmlFor="purge-days">Remove after</label>
          <input id="purge-days" className="purge-days" type="number" min="1" max="365" value={purgeDays} disabled={!status || memoryBusy} onChange={(event) => setPurgeDays(Number(event.target.value))} onBlur={() => {
            if (Number.isInteger(purgeDays) && purgeDays >= 1 && purgeDays <= 365) void updateConfig({ purge_days: purgeDays }, `Negative lessons purge after ${purgeDays} days.`);
            else setMemoryFeedback("Purge period must be between 1 and 365 days.");
          }} />
          <span className="purge-unit">days</span>
          <button id="prune-now" className="button" type="button" disabled={!status || memoryBusy} onClick={() => void runMemoryAction("memory.prune", "Cleanup complete.")}>Clean up now</button>
        </div>
      </div>

      <div className="card memory-card">
        <div className="memory-head">
          <div>
            <h2>Overview</h2>
            <span className="memory-state-line">A quick read on how your memory is growing.</span>
          </div>
        </div>
        <div className="memory-stats">
          {stats.map(([id, value, label]) => <div key={id} className="memory-stat"><span id={id} className={id === "memory-success" ? "memory-success" : undefined}>{value}</span><span className="stat-label">{label}</span></div>)}
        </div>
        <MemoryChart daily={status?.recent_daily} />
      </div>

      <div className="card memory-card">
        <div className="memory-head">
          <div>
            <h2>Share memory</h2>
            <span className="memory-state-line">Snapshots contain no personal page content.</span>
          </div>
        </div>
        <div className="memory-actions">
          <button id="export-json" className="button" type="button" disabled={!status || memoryBusy} onClick={async () => {
            try {
              const payload = await memoryCall<unknown>("memory.export");
              const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `action-memory-${new Date().toISOString().slice(0, 10)}.json`;
              anchor.click();
              URL.revokeObjectURL(url);
              setShareFeedback("Exported your memory snapshot.");
            } catch (error) {
              setShareFeedback(errorMessage(error));
            }
          }}>Export JSON</button>
          <label className="button file-button" htmlFor="import-json">Import JSON</label>
          <input id="import-json" type="file" accept="application/json" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              const result = await memoryCall<{ imported: number }>("memory.import", JSON.parse(await file.text()));
              setShareFeedback(`Imported ${result.imported} signatures.`);
              await refreshMemory();
            } catch (error) {
              setShareFeedback(`Import failed: ${errorMessage(error)}`);
            } finally {
              event.target.value = "";
            }
          }} />
        </div>
        <p id="share-feedback" className="feedback" role="status">{shareFeedback}</p>
      </div>
    </section>
  );
}
