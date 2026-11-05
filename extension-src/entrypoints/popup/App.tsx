import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { t } from "../../i18n";
import { sendMessage, type NativeStatus, type Profile } from "./api";
import ConnectionView from "./ConnectionView";
import DecisionOverview from "./DecisionOverview";
import HarnessConnections from "./HarnessConnections";
import HomeStatus from "./HomeStatus";
import Icon from "./Icon";
import MemoryView from "./MemoryView";
import ProfileMenu from "./ProfileMenu";
import SettingsView, { type SettingsSection } from "./SettingsView";
import VersionNotice from "./VersionNotice";

function useNativeStatus(): NativeStatus {
  const [status, setStatus] = useState<NativeStatus>({ state: "unknown" });
  const appliedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;
    let fallbackTimer: number | null = null;

    const apply = (next: NativeStatus | undefined) => {
      if (!disposed && next) {
        appliedRef.current = true;
        setStatus(next);
      }
    };

    const requestOnce = async () => {
      try {
        const response = await sendMessage<{ status?: NativeStatus }>({ type: "GET_NATIVE_HOST_STATUS" });
        if (response.status) apply(response.status);
      } catch (error) {
        if (!disposed) setStatus({ state: "unavailable", error: error instanceof Error ? error.message : String(error) });
      }
    };

    try {
      port = browser.runtime.connect({ name: "popup-status" });
      port.onMessage.addListener((message: { type?: string; status?: NativeStatus }) => {
        if (message.type === "NATIVE_STATUS" || message.type === "STATUS_SNAPSHOT") apply(message.status);
      });
      fallbackTimer = window.setTimeout(() => {
        if (!appliedRef.current) void requestOnce();
      }, 800);
      port.onDisconnect.addListener(() => {
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        port = null;
        void requestOnce();
      });
    } catch {
      void requestOnce();
    }

    return () => {
      disposed = true;
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      port?.disconnect();
    };
  }, []);

  return status;
}

export default function App(): React.JSX.Element {
  const [view, setView] = useState<"home" | "settings" | "activity" | "profile">("home");
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRevision = useRef(0);
  const [statisticsExpanded, setStatisticsExpanded] = useState(false);
  const status = useNativeStatus();
  const heading = useRef<HTMLHeadingElement>(null), settingsButton = useRef<HTMLButtonElement>(null), activityButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const revision = ++profileRevision.current;
    void sendMessage<{ profile?: Profile }>({ type: "GET_PROFILE" }).then(r => { if (active && revision === profileRevision.current && r.profile) setProfile(r.profile); }).catch(() => {});
    return () => { active = false; };
  }, [status.state, view]);
  useEffect(() => { scroller.current?.scrollTo(0, 0); if (view !== "home") heading.current?.focus({ preventScroll: true }); else setStatisticsExpanded(false); }, [view, section]);
  function back() {
    if (section) { setSection(null); return; }
    const previous = view; setView("home");
    requestAnimationFrame(() => (previous === "settings" ? settingsButton.current : previous === "activity" ? activityButton.current : document.querySelector<HTMLButtonElement>(".profile-trigger"))?.focus());
  }
  return <main className={`compact-popup popup-${view}`}>
    {view === "home" ? <header id="app-header">
      <img id="app-logo" src="/images/popup/logo.png" width="30" height="30" alt="" />
      <div id="app-identity"><h1>OpenCode Browser</h1><p id="app-subtitle">{t("browserAgent")}</p></div>
      <button ref={settingsButton} id="open-settings" className="icon-button" type="button" aria-label={t("settings")} onClick={() => setView("settings")}><Icon name="settings" size={16} /></button>
    </header> : <header className="subpage-header"><button className="back-button" type="button" aria-label={t(section ? "backToSettings" : "backToHome")} onClick={back}><Icon name="arrow-left" size={16} /></button><div><h1 ref={heading} tabIndex={-1}>{t(view === "settings" ? "settings" : view === "activity" ? "activityMemory" : "browserProfile")}</h1><p>{profile?.profileLabel ? `${profile.profileLabel} · ` : ""}{t("thisBrowserShort")}</p></div></header>}
    <div className="popup-scroll" ref={scroller}>
      {view === "home" && <div className="home-stack">
        <ProfileMenu profile={profile} connected={status.state === "connected"} onRename={() => setView("profile")} />
        <HarnessConnections status={status} />
        <HomeStatus status={status} />
        <MemoryView view="summary" available={status.state === "connected"} onView={() => setView("activity")} viewButtonRef={activityButton} />
      </div>}
      {view === "settings" && <><SettingsView status={status} section={section} onSection={setSection} />{(!section || section === "updates") && <VersionNotice status={status} showSnoozed />}</>}
      {view === "activity" && <><DecisionOverview expanded={statisticsExpanded} available={status.state === "connected"} /><MemoryView available={status.state === "connected"} onDetails={setStatisticsExpanded} onRetry={() => { setView("settings"); setSection("connection"); }} /></>}
      {view === "profile" && <ConnectionView status={status} view="profiles" onProfileSaved={value => { profileRevision.current++; setProfile(value); }} />}
    </div>
    <div id="popup-feedback" />
    {(view === "home" || view === "settings" && !section) && <footer id="app-footer">
      {view === "home" ? <a href={browser.runtime.getURL("/welcome.html")} target="_blank" rel="noopener">{t("setupGuide")}</a> : <span>v{browser.runtime.getManifest().version}</span>}
      {view === "home" ? <span id="app-version">v{browser.runtime.getManifest().version_name ?? browser.runtime.getManifest().version}</span> : <a id="repo-link" href="https://github.com/Quindart-com/opencode-chromium" target="_blank" rel="noopener">{t("sourceGithub")}</a>}
    </footer>}
  </main>;
}
