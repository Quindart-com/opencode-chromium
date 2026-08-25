import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { sendMessage, type NativeStatus } from "./api";
import ConnectionView from "./ConnectionView";
import MemoryView from "./MemoryView";

type ViewName = "connection" | "memory";

function statusClass(state: string): string {
  if (state === "connected") return "pill-ok";
  if (state === "reconnecting" || state === "unknown") return "pill-warn";
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
  const statusText = status.error ? `${state}: ${status.error}` : state;

  return (
    <header id="app-header">
      <img id="app-logo" src="/images/icon48.png" width="48" height="48" alt="opencode-chromium logo" />
      <div id="app-identity">
        <h1>opencode-chromium</h1>
        <p id="app-subtitle">
          <span id="app-version">v{browser.runtime.getManifest().version}</span> · Local browser automation
        </p>
      </div>
      <div id="status-pill" className={`pill ${statusClass(state)}`} role="status">
        <span id="status-dot" aria-hidden="true" />
        <span id="status">{statusText}</span>
      </div>
    </header>
  );
}

function ViewTabs({ active, onChange }: { active: ViewName; onChange: (view: ViewName) => void }): React.JSX.Element {
  return (
    <nav className="view-tabs" role="tablist" aria-label="Extension views">
      {(["connection", "memory"] as const).map((view) => {
        const isActive = view === active;
        return (
          <button
            key={view}
            id={`tab-${view}`}
            className={`view-tab${isActive ? " active" : ""}`}
            role="tab"
            aria-selected={isActive}
            type="button"
            onClick={() => onChange(view)}
          >
            {view === "connection" ? "Connection" : "Action Memory"}
          </button>
        );
      })}
    </nav>
  );
}

export default function App(): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewName>("connection");
  const nativeStatus = useNativeStatus();

  return (
    <main>
      <Header status={nativeStatus} />
      <ViewTabs active={activeView} onChange={setActiveView} />
      {activeView === "connection" ? <ConnectionView status={nativeStatus} /> : <MemoryView />}
      <footer id="app-footer">
        <a id="repo-link" href="https://github.com/Quindart-com/opencode-chromium" target="_blank" rel="noopener">
          Source on GitHub
        </a>
      </footer>
    </main>
  );
}
