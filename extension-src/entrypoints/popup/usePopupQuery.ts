import { useEffect, useState } from "react";
import { sendMessage } from "./api";

/** Small read-only summaries must distinguish missing data from loading. */
export default function usePopupQuery<T>(type: string, field: "result" | "semantic", enabled: boolean) {
  const [data, setData] = useState<T | null>(null), [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setState("loading");
    if (!enabled) return;
    const timer = window.setTimeout(() => { if (active) { active = false; setState("error"); } }, 10000);
    void sendMessage<{ result?: T; semantic?: T; error?: string }>({ type }).then(response => {
      window.clearTimeout(timer);
      if (response.error || response[field] == null) throw new Error("unavailable");
      if (active) { setData(response[field]); setState("ready"); }
    }).catch(() => { window.clearTimeout(timer); if (active) setState("error"); });
    return () => { active = false; window.clearTimeout(timer); };
  }, [type, field, enabled, revision]);
  return { data, state, retry: () => setRevision(value => value + 1) };
}
