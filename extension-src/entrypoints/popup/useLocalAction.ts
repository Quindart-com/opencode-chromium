import { useCallback,useEffect,useRef,useState } from "react";
import type { LocalAction } from "../../../src/shared/local-actions.ts";
import { t } from "../../i18n";
import { sendMessage } from "./api";

const labels: Record<string, string> = {
  queued: "actionQueued", running: "actionRunning", refreshed: "actionReconnected", busy: "actionBusy",
  waiting_for_harness: "actionWaiting", unreachable: "actionUnreachable", healthy: "actionHealthy",
  needs_attention: "actionNeedsAttention", updated: "actionUpdated", update_waiting: "actionUpdateWaiting",
  not_installed: "statusNotInstalled", unmanaged_runtime: "actionUnmanaged",
};
export const localActionLabel = (action: LocalAction) => t(labels[action.code] ?? (action.state === "failed" ? "actionFailed" : action.state === "waiting" ? "actionWaiting" : "actionRunning"));
export default function useLocalAction() {
  const [action, setAction] = useState<LocalAction | null>(null), [starting, setStarting] = useState(false), [error, setError] = useState("");
  const revision = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  const start = useCallback(async (type: string, params: Record<string, unknown> = {}) => {
    const operation = ++revision.current;
    setStarting(true); setError(""); setAction(null);
    try {
      const response = await sendMessage<{ result?: LocalAction; error?: string }>({ type, params });
      if (!mounted.current || operation !== revision.current) return;
      if (!response.result?.id) throw new Error("unavailable");
      setAction(response.result);
    } catch { if (mounted.current && operation === revision.current) setError(t("actionUnavailable")); }
    finally { if (mounted.current && operation === revision.current) setStarting(false); }
  }, []);
  useEffect(() => {
    if (!action || !["queued", "running"].includes(action.state)) return;
    const id = action.id, operation = revision.current;
    let disposed = false, pending = false;
    const timer = window.setInterval(() => {
      if (pending) return; pending = true;
      void sendMessage<{ result?: LocalAction | null; error?: string }>({ type: "GET_LOCAL_ACTION", params: { id } }).then(response => {
        if (disposed || operation !== revision.current) return;
        if (response.result?.id === id) { setAction(response.result); setError(""); }
        else if (response.error) setError(t("actionStatusUnavailable"));
        else setAction({ ...action, state: "failed", code: "worker_stopped", updatedAt: Date.now() });
      }, () => { if (!disposed) setError(t("actionStatusUnavailable")); }).finally(() => { pending = false; });
    }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [action?.id, action?.state]);
  return { action, start, error, working: starting || !!action && ["queued", "running"].includes(action.state), feedback: error || (action ? localActionLabel(action) : "") };
}
