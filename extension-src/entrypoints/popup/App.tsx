import { useEffect,useRef,useState } from "react";
import { browser } from "wxt/browser";
import { sendMessage,type NativeStatus } from "./api";
import ConnectionSummary from "./ConnectionSummary";
import ConnectionView from "./ConnectionView";
import DecisionOverview from "./DecisionOverview";
import MemoryView from "./MemoryView";
import ProviderSettings from "./ProviderSettings";
import RuntimeUpdates from "./RuntimeUpdates";
import UploadSettings from "./UploadSettings";
import VersionNotice from "./VersionNotice";

const t = (key: "connected" | "checking" | "reconnecting" | "notConnected" | "localAutomation" | "extensionViews" | "overview" | "profiles" | "settings" | "setupGuide" | "sourceGithub") => browser.i18n.getMessage(key);

type ViewName = "overview" | "profiles" | "settings";

function statusClass(state: string): string {
  if (state === "connected") return "pill-ok";
  if (state === "connecting" || state === "reconnecting" || state === "unknown") return "pill-warn";
  return "pill-bad";
}

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

function Header({ status }: { status: NativeStatus }): React.JSX.Element {
  const state = status.state ?? "unknown";
  const statusText = state === "connected" ? t("connected") : state === "unknown" || state === "connecting" ? t("checking") : state === "reconnecting" ? t("reconnecting") : t("notConnected");

  return (
    <header id="app-header">
      <img id="app-logo" src="/images/icon48.png" width="48" height="48" alt="opencode-chromium logo" />
      <div id="app-identity">
        <h1>OpenCode Browser</h1>
        <p id="app-subtitle">
          <span id="app-version">v{browser.runtime.getManifest().version_name ?? browser.runtime.getManifest().version}</span> · {t("localAutomation")}
        </p>
      </div>
      <div id="status-pill" className={`pill ${statusClass(state)}`} role="status" hidden={state === "connected"}>
        <span id="status-dot" aria-hidden="true" />
        <span id="status">{statusText}</span>
      </div>
    </header>
  );
}

function ViewTabs({ active, onChange }: { active: ViewName; onChange: (view: ViewName) => void }): React.JSX.Element {
  return (
    <nav className="view-tabs" role="tablist" aria-label={t("extensionViews")}>
      {(["overview", "profiles", "settings"] as const).map((view) => {
        const isActive = view === active;
        return (
          <button
            key={view}
            id={`tab-${view}`}
            className={`view-tab${isActive ? " active" : ""}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${view}`}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={event => {
              const views = ["overview", "profiles", "settings"] as const;
              const index = views.indexOf(view);
              const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : null;
              if (next === null) return;
              event.preventDefault(); onChange(views[next]!);
              document.getElementById(`tab-${views[next]}`)?.focus();
            }}
            type="button"
            onClick={() => onChange(view)}
          >
            {t(view)}
          </button>
        );
      })}
    </nav>
  );
}

export default function App(): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewName>("overview");
  const nativeStatus = useNativeStatus();
  const changeView = (view: ViewName) => {
    setActiveView(view);
    document.getElementById(`tab-${view}`)?.focus();
  };

  return (
    <main>
      <Header status={nativeStatus} />
      <VersionNotice status={nativeStatus} showSnoozed={activeView === "settings"} />
      <ViewTabs active={activeView} onChange={changeView} />
      <div className="view-panel" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" hidden={activeView !== "overview"}>
        {activeView === "overview" && <><ConnectionSummary status={nativeStatus} /><DecisionOverview onConfigure={() => changeView("settings")} /><MemoryView /></>}
      </div>
      <div className="view-panel" role="tabpanel" id="panel-profiles" aria-labelledby="tab-profiles" hidden={activeView !== "profiles"}>
        {activeView === "profiles" && <ConnectionView status={nativeStatus} view="profiles" />}
      </div>
      <div className="view-panel" role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={activeView !== "settings"}>
        {activeView === "settings" && <><ProviderSettings /><UploadSettings /><MemoryView view="settings" /><RuntimeUpdates /><ConnectionView status={nativeStatus} view="settings" /></>}
      </div>
      <footer id="app-footer">
        <a href={browser.runtime.getURL("/welcome.html")} target="_blank" rel="noopener">{t("setupGuide")}</a>
        <a id="repo-link" href="https://github.com/Quindart-com/opencode-chromium" target="_blank" rel="noopener">
          {t("sourceGithub")}
        </a>
      </footer>
    </main>
  );
}
