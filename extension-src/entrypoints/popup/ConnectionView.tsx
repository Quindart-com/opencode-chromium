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

type ConnectionViewProps = { status: NativeStatus };

function statusText(status: NativeStatus): string {
  const state = status.state ?? "unknown";
  return status.error ? `${state}: ${status.error}` : state;
}

function modelDescription(model: SemanticModel | undefined): string {
  if (!model) return "No model metadata available.";
  const cache = model.cache?.cached ? "cached locally" : "not cached yet";
  const reranker = model.reranker?.id ? ` Reranker: ${model.reranker.id}.` : "";
  return `${model.description ?? "Local semantic retrieval model."} Embedding: ${model.embedding?.id ?? "n/a"}.${reranker} Benchmark: ${model.benchmark?.label ?? "quality"} ${model.benchmark?.value ?? "n/a"}. Size: ${model.parameters ?? "n/a"}, ${model.dimensions ?? "n/a"} dimensions, ${cache}.`;
}

function semanticStatusText(semantic: SemanticState): string {
  const load = semantic.load ?? {};
  const model = semantic.models?.find((item) => item.id === load.modelId) ?? semantic.models?.[0];
  const cacheDir = semantic.cacheDir ? ` Cache: ${semantic.cacheDir}` : "";
  if (load.state === "loading") {
    const progress = Number.isFinite(load.progress) ? ` ${load.progress}%` : "";
    const component = load.component ? ` ${load.component}` : "";
    return `Preparing${component} for ${model?.label ?? "model"}...${progress}${cacheDir}`;
  }
  if (load.state === "ready") return `Ready: ${model?.label ?? load.modelId}.${cacheDir}`;
  if (load.state === "error") return `Model error: ${load.error ?? "unknown error"}.${cacheDir}`;
  return `Snowflake retrieval is the default. Lexical and auto search remain available; download and load failures degrade safely.${cacheDir}`;
}

export default function ConnectionView({ status }: ConnectionViewProps): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLabel, setProfileLabel] = useState("");
  const [profileHelp, setProfileHelp] = useState("Labels stay local and are used only to pick the right open browser profile.");
  const [profileBusy, setProfileBusy] = useState(false);
  const [semantic, setSemantic] = useState<SemanticState | null>(null);
  const [semanticHelp, setSemanticHelp] = useState("Loading model options...");
  const [semanticBusy, setSemanticBusy] = useState(false);

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
  const selectedModel = useMemo(
    () => models.find((model) => model.id === settings.modelId) ?? models[0],
    [models, settings.modelId],
  );

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

  async function saveSemantic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await updateSemantic(
      {
        type: "SET_SEMANTIC_SETTINGS",
        enabled: settings.enabled === true,
        modelId: selectedModel?.id,
        preload: settings.enabled === true,
      },
      "Saving semantic settings...",
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
            <dd id="profile-id" className="mono">{profile?.profileId ?? "Checking..."}</dd>
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
        <form id="semantic-form" onSubmit={saveSemantic}>
          <label className="checkbox-row">
            <input
              id="semantic-enabled"
              type="checkbox"
              checked={settings.enabled === true}
              onChange={(event) => setSemantic((current) => ({ ...current, settings: { ...current?.settings, enabled: event.target.checked } }))}
            />
            <span>Enable Snowflake semantic retrieval</span>
          </label>
          <label htmlFor="semantic-model">Local model cache</label>
          <select
            id="semantic-model"
            name="semantic-model"
            value={selectedModel?.id ?? ""}
            onChange={(event) => setSemantic((current) => ({ ...current, settings: { ...current?.settings, modelId: event.target.value } }))}
            disabled={semanticBusy || models.length === 0}
          >
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          <div id="semantic-model-info" className="model-info">{modelDescription(selectedModel)}</div>
          <div className="button-row">
            <button type="submit" className="primary" disabled={semanticBusy}>Save settings</button>
            <button
              id="semantic-prepare"
              type="button"
              className="secondary"
              disabled={semanticBusy || !selectedModel}
              onClick={() => void updateSemantic({ type: "PREPARE_SEMANTIC_MODEL", modelId: selectedModel?.id }, "Starting local model preparation...")}
            >
              Prepare model
            </button>
            <button
              id="semantic-delete"
              type="button"
              className="danger"
              disabled={semanticBusy || !selectedModel}
              onClick={() => {
                if (selectedModel && window.confirm(`Delete local files for ${selectedModel.label}? They can be downloaded again later.`)) {
                  void updateSemantic({ type: "DELETE_SEMANTIC_MODEL", modelId: selectedModel.id }, "Deleting local model files...");
                }
              }}
            >
              Delete files
            </button>
          </div>
          <p id="semantic-help">{semanticHelp}</p>
        </form>
      </div>
    </section>
  );
}
