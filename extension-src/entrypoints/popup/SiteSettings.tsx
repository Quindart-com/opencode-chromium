import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { sendMessage } from "./api";
import usePopupQuery from "./usePopupQuery";

export type SiteStatus = { enabled: boolean; sharing?: boolean; patternChoice?: boolean; patternSharingSupported?: boolean; configured?: boolean };
const SITE_SETTINGS_EVENT = "opencode-site-settings";
/** Tells every mounted switch to reload, since Action Memory can turn on task patterns. */
export const siteSettingsChanged = () => window.dispatchEvent(new Event(SITE_SETTINGS_EVENT));

export function useSiteStatus(enabled = true) {
  const query = usePopupQuery<SiteStatus>("GET_SITE_SETTINGS", "result", enabled);
  const [fresh, setFresh] = useState<SiteStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void sendMessage<{ result?: SiteStatus }>({ type: "GET_SITE_SETTINGS" })
      .then(reply => { if (reply.result) setFresh(reply.result); }).catch(() => {});
    window.addEventListener(SITE_SETTINGS_EVENT, refresh);
    return () => window.removeEventListener(SITE_SETTINGS_EVENT, refresh);
  }, [enabled]);
  return [fresh ?? query.data, setFresh] as const;
}

export default function SiteSettings() {
  const [status, setStatus] = useSiteStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Builds without a registry have nothing behind these switches.
  if (!status?.configured) return null;
  async function change(type: string, enabled: boolean) {
    setBusy(true);
    setError(false);
    try {
      const reply = await sendMessage<{ result?: SiteStatus; error?: string }>({ type, enabled, ...(type === "SET_SITE_SETTINGS" ? { params: { includePackages: true } } : {}) });
      if (!reply.result) throw Error(reply.error);
      setStatus(reply.result);
      siteSettingsChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (title: string, detail: string, type: string, enabled: boolean, supported: boolean) =>
    <section className="setting-row compact-upload"><div><h2>{title}</h2><small>{detail}</small></div>
      <button type="button" role="switch" aria-label={title} aria-checked={enabled}
        disabled={busy || !supported} className={"switch" + (enabled ? " on" : "")}
        onClick={event => { if (event.nativeEvent.isTrusted) void change(type, !enabled); }}><span /></button>
    </section>;
  return <>
    {toggle(t("contributeTaskPatterns"), t("contributeTaskPatternsDescription"), "SET_PATTERN_SHARING", Boolean(status.sharing), status.patternSharingSupported === true)}
    {toggle(t("sharedSiteReads"), t("sharedSiteReadsDescription"), "SET_SITE_SETTINGS", status.enabled, status.sharing === true)}
    {error && <p role="status">{t("siteSettingsSaveFail")}</p>}
  </>;
}
