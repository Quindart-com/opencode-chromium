import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  errorMessage,
  responseError,
  sendMessage,
  type NativeStatus,
  type Profile,
  type SemanticModel,
  type SemanticState,
} from "./api";
import { maskIdentifier } from "./privacy";

type ConnectionViewProps = { status: NativeStatus };

function statusText(status: NativeStatus): string {
  const state = status.state ?? "unknown";
  return status.error ? `${state}: ${status.error}` : state;
}

function semanticStatusText(semantic: SemanticState): string {
  const load = semantic.load ?? {};
  const model = semantic.models?.find((item) => item.id === load.modelId);
  if (load.state === "loading") {
    const progress = Number.isFinite(load.progress) ? ` ${load.progress}%` : "";
    const component = load.component ? ` ${load.component}` : "";
    return `Downloading ${component ?? "model"} for ${model?.label ?? load.modelId ?? "model"}...${progress}`;
  }
  if (load.state === "ready") return `Ready: ${model?.label ?? load.modelId ?? "model"}. Model cache: local.`;
  if (load.state === "error") return `Model error: ${load.error ?? "unknown error"}.`;
  return "Retrieval runs locally with the active model and falls back to lexical ranking. Deep search loads Qwen on demand; download failures degrade safely.";
}

export default function ConnectionView({ status }: ConnectionViewProps): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLabel, setProfileLabel] = useState("");
  const [profileHelp, setProfileHelp] = useState("Labels stay local and are used only to pick the right open browser profile.");
  const [profileBusy, setProfileBusy] = useState(false);
  const [semantic, setSemantic] = useState<SemanticState | null>(null);
  const [semanticHelp, setSemanticHelp] = useState("Loading model options...");
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [profileIdRevealed, setProfileIdRevealed] = useState<string | null>(null);
  const [cacheCopyState, setCacheCopyState] = useState<"idle" | "copied" | "error">("idle");

  const maskedProfileId = maskIdentifier(profile?.profileIdMasked ?? profile?.profileId ?? "");
  const displayedProfileId = profileIdRevealed ?? maskedProfileId;

  async function revealProfileId(): Promise<string | null> {
    if (profileIdRevealed) return profileIdRevealed;
    try {
      const response = await sendMessage<{ profile?: Profile; error?: string }>({ type: "GET_PROFILE_DETAILS" });
      const error = responseError(response);
      if (error) throw new Error(error);
      const id = response.profile?.profileId ?? null;
      if (id) setProfileIdRevealed(id);
      return id;
    } catch {
      return null;
    }
  }

  async function copyProfileId() {
    const id = await revealProfileId();
    if (id) await navigator.clipboard.writeText(id).catch(() => {});
  }

  async function copyCachePath() {
    try {
      const response = await sendMessage<{ diagnostics?: { cacheDir?: string }; error?: string }>({ type: "GET_SEMANTIC_DIAGNOSTICS" });
      const error = responseError(response);
      if (error) throw new Error(error);
      const cacheDir = response.diagnostics?.cacheDir ?? "";
      if (!cacheDir) throw new Error("cache unavailable");
      await navigator.clipboard.writeText(cacheDir);
      setCacheCopyState("copied");
    } catch {
      setCacheCopyState("error");
    } finally {
      window.setTimeout(() => setCacheCopyState("idle"), 2000);
    }
  }

  const loadSemantic = useCallback(async () => {
    try {
      const response = await sendMessage<{ semantic?: SemanticState; error?: string }>({ type: "GET_SEMANTIC_SETTINGS" });
      const error = responseError(response);
      if (error) throw new Error(error);
      const next = response.semantic ?? {};
      setSemantic(next);
      setSemanticHelp(semanticStatusText(next));
    } catch (error) {
      setSemanticHelp(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void sendMessage<{ profile?: Profile; error?: string }>({ type: "GET_PROFILE" })
      .then((response) => {
        if (!active) return;
        const error = responseError(response);
        if (error) throw new Error(error);
        if (response.profile) {
          setProfile(response.profile);
          setProfileLabel(response.profile.profileLabel ?? "");
        }
      })
      .catch((error) => {
        if (active) setProfileHelp(errorMessage(error));
      });
    void loadSemantic();
    return () => {
      active = false;
    };
  }, [loadSemantic]);

  useEffect(() => {
    if (semantic?.load?.state !== "loading") return undefined;
    const timer = window.setInterval(() => void loadSemantic(), 1500);
    return () => window.clearInterval(timer);
  }, [loadSemantic, semantic?.load?.state]);

  const models = semantic?.models ?? [];
  const settings = semantic?.settings ?? {};
  const enabled = settings.enabled === true;
  const activeModelId = settings.modelId;
  const load = semantic?.load;
  const loading = load?.state === "loading";
  const adaptiveModels = useMemo(() => models.filter((model) => model.role !== "deep"), [models]);
  const deepModel = useMemo(() => models.find((model) => model.role === "deep"), [models]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileHelp("Saving...");
    try {
      const response = await sendMessage<{ profile?: Profile; error?: string }>({ type: "SET_PROFILE_LABEL", label: profileLabel });
      const error = responseError(response);
      if (error) throw new Error(error);
      if (response.profile) {
        setProfile(response.profile);
        setProfileLabel(response.profile.profileLabel ?? "");
      }
      setProfileHelp("Saved. Pass this profile label to the first useful browser call.");
    } catch (error) {
      setProfileHelp(errorMessage(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateSemantic(message: object, busyText: string) {
    setSemanticBusy(true);
    setSemanticHelp(busyText);
    try {
      const response = await sendMessage<{ semantic?: SemanticState; error?: string }>(message);
      const error = responseError(response);
      if (error) throw new Error(error);
      const next = response.semantic ?? semantic ?? {};
      setSemantic(next);
      setSemanticHelp(semanticStatusText(next));
    } catch (error) {
      setSemanticHelp(errorMessage(error));
    } finally {
      setSemanticBusy(false);
    }
  }

  function toggleSemantic(next: boolean) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled: next, modelId: activeModelId, preload: next },
      next ? "Enabling semantic retrieval..." : "Disabling semantic retrieval...",
    );
  }

  function useModel(model: SemanticModel) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled: true, modelId: model.id, preload: true },
      `Switching retrieval to ${model.label}...`,
    );
  }

  function prepareModel(model: SemanticModel) {
    void updateSemantic({ type: "PREPARE_SEMANTIC_MODEL", modelId: model.id }, `Downloading ${model.label}...`);
  }

  function deleteModel(model: SemanticModel) {
    if (window.confirm(`Delete local files for ${model.label}? They can be downloaded again later.`)) {
      void updateSemantic({ type: "DELETE_SEMANTIC_MODEL", modelId: model.id }, `Deleting local files for ${model.label}...`);
    }
  }

  function renderModelCard(model: SemanticModel) {
    const isAdaptive = model.role !== "deep";
    const isActive = isAdaptive && model.id === activeModelId;
    const cached = model.cache?.cached === true;
    const busyForModel = semanticBusy || (loading && load?.modelId === model.id);
    return (
      <div key={model.id} className={`model-card${isActive ? " active" : ""}`} data-model-id={model.id}>
        <div className="model-head">
          <span className="model-name">{model.label}</span>
          {model.default === true ? <span className="badge badge-default">Default</span> : null}
          <span className={`badge ${cached ? "badge-ok" : "badge-neutral"}`}>{cached ? "Ready" : "Not downloaded"}</span>
        </div>
        <div className="model-meta">
          {model.parameters ?? "n/a"} · {model.dimensions ?? "n/a"}-dim · ctx {model.contextLength ?? "512"}
          {isAdaptive ? "" : " · deep search only"}
        </div>
        <div className="model-desc">{model.description ?? "Local retrieval model."}</div>
        {model.benchmark?.value ? <div className="model-bench">{model.benchmark.label}: {model.benchmark.value}</div> : null}
        <div className="model-actions">
          {isAdaptive && isActive ? (
            <span className="model-active-note" aria-label="Active retrieval model">Active</span>
          ) : null}
          {isAdaptive && !isActive ? (
            <button
              type="button"
              className="button-use"
              disabled={busyForModel}
              onClick={() => useModel(model)}
            >
              Use
            </button>
          ) : null}
          {!isAdaptive ? (
            <span className="model-active-note">On demand</span>
          ) : null}
          <button
            type="button"
            className="button-prepare"
            disabled={busyForModel}
            onClick={() => prepareModel(model)}
          >
            {cached ? "Re-download" : "Download"}
          </button>
          <button
            type="button"
            className="button-delete"
            disabled={busyForModel || !cached}
            onClick={() => deleteModel(model)}
          >
            Delete
          </button>
        </div>
        {loading && load?.modelId === model.id ? (
          <div className="model-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number.isFinite(load?.progress) ? load?.progress : undefined}>
            <div className="model-progress-fill" style={{ width: `${Math.max(4, Math.min(100, load?.progress ?? 4))}%` }} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section id="view-connection" className="view">
      <div className="card" aria-labelledby="connection-title">
        <h2 id="connection-title">Connection</h2>
        <dl id="connection-list">
          <div>
            <dt>Status</dt>
            <dd id="status-detail">{statusText(status)}</dd>
          </div>
          <div>
            <dt>Host</dt>
            <dd id="host">{status.hostName ?? "com.opencode.browser.plugin"}</dd>
          </div>
          <div>
            <dt>Last Check</dt>
            <dd id="last-checked">{status.lastChecked ? new Date(status.lastChecked).toLocaleString() : "-"}</dd>
          </div>
          <div>
            <dt>Profile ID</dt>
            <dd id="profile-id" className="mono profile-id-row">
              <span className="mono-value">{displayedProfileId || "Checking..."}</span>
              <button
                type="button"
                className="button-mini"
                onClick={() => {
                  if (profileIdRevealed) setProfileIdRevealed(null);
                  else void revealProfileId();
                }}
              >
                {profileIdRevealed ? "Hide" : "Reveal"}
              </button>
              <button type="button" className="button-mini" onClick={() => void copyProfileId()}>Copy</button>
            </dd>
          </div>
        </dl>
      </div>

      <div className="card" aria-labelledby="profile-title">
        <h2 id="profile-title">Profile</h2>
        <form id="profile-form" onSubmit={saveProfile}>
          <label htmlFor="profile-label">Profile label</label>
          <div className="input-row">
            <input
              id="profile-label"
              name="profile-label"
              type="text"
              maxLength={80}
              placeholder="work, personal, staging"
              value={profileLabel}
              onChange={(event) => setProfileLabel(event.target.value)}
            />
            <button type="submit" className="button button-primary" disabled={profileBusy}>Save</button>
          </div>
          <p id="profile-help">{profileHelp}</p>
        </form>
      </div>

      <div className="card" aria-labelledby="semantic-title">
        <h2 id="semantic-title">Semantic page search</h2>
        <div className="semantic-toggle-row">
          <div className="semantic-toggle-copy">
            <span className="semantic-toggle-title">Semantic retrieval</span>
            <span className="semantic-toggle-sub">Local page ranking with lexical fallback</span>
          </div>
          <button
            id="semantic-enabled"
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable semantic retrieval"
            className={`switch${enabled ? " on" : ""}`}
            disabled={semanticBusy}
            onClick={() => toggleSemantic(!enabled)}
          >
            <span className="switch-knob" />
          </button>
        </div>
        <div id="semantic-model-list" className="model-list" aria-label="Retrieval models">
          {adaptiveModels.map(renderModelCard)}
          {deepModel ? renderModelCard(deepModel) : null}
        </div>
        <p id="semantic-help">{semanticHelp}</p>
        <details id="semantic-dev-details" className="dev-details">
          <summary>Developer details</summary>
          <div className="dev-details-row">
            <span className="dev-details-label">Cache location</span>
            <span className="dev-details-value">Local model cache</span>
            <button type="button" className="button-mini" onClick={() => void copyCachePath()}>
              {cacheCopyState === "copied" ? "Copied" : cacheCopyState === "error" ? "Failed" : "Copy path"}
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}
