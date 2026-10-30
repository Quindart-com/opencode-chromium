import { t } from "../../i18n";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  errorMessage,
  responseError,
  sendMessage,
  memoryCall,
  type MemoryProfiles,
  type NativeStatus,
  type Profile,
  type SemanticModel,
  type SemanticState,
} from "./api";
import { maskIdentifier } from "./privacy";

const knownModelDescriptions = new Map<string, string>([
  ["Default English page retrieval with a compact 22.6M parameter Snowflake embedding model. Use lexical or auto explicitly when lower latency is preferred.", "modelXs"],
  ["Larger Snowflake retrieval model with stronger relevance at 768 dimensions. Choose it when quality matters more than local disk and memory footprint.", "modelM"],
  ["Multilingual on-device embedding model with Matryoshka output dimensions (128/256/512/768). 256 dimensions is the recommended size-to-quality balance.", "modelGemma"],
  ["Current local retrieval stack: Qwen3 embeddings for broad page search plus Qwen3 reranking for the final relevant context.", "modelQwen"],
]);
const strategyKeys: Record<string, string> = { auto: "strategyAuto", semantic: "strategySemantic", lexical: "strategyLexical", deep: "strategyDeep", lean: "detailLean", compact: "detailCompact", debug: "detailDebug" };
const translateStrategy = (value: string) => strategyKeys[value] ? t(strategyKeys[value]!) : value;

type ConnectionViewProps = { status: NativeStatus; view?: "profiles" | "settings" };

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
    return t("modelDownload", [component.trim() || t("modelWord"), model?.label ?? load.modelId ?? t("modelWord"), progress]);
  }
  if (load.state === "ready") return t("modelReady", model?.label ?? load.modelId ?? t("modelWord"));
  if (load.state === "error") return t("modelError", load.error ?? t("modelUnknown"));
  return t("searchLocalDetail");
}

export default function ConnectionView({ status, view = "profiles" }: ConnectionViewProps): React.JSX.Element {
  const [connectedProfiles, setConnectedProfiles] = useState<MemoryProfiles | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLabel, setProfileLabel] = useState("");
  const [profileHelp, setProfileHelp] = useState(t("profileLabelHelp"));
  const [profileBusy, setProfileBusy] = useState(false);
  const [semantic, setSemantic] = useState<SemanticState | null>(null);
  const [semanticHelp, setSemanticHelp] = useState(t("loadingModels"));
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
    if (!id) { setProfileHelp(t("profileIdUnavailable")); return; }
    try { await navigator.clipboard.writeText(id); setProfileHelp(t("profileCopied")); }
    catch { setProfileHelp(t("profileCopyFail")); }
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
    void memoryCall<MemoryProfiles>("memory.profiles").then((result) => { if (active) { setConnectedProfiles(result); setSelectedProfile(result.currentProfileId ?? ""); } }).catch(() => {});
    if (view === "settings") void loadSemantic();
    return () => {
      active = false;
    };
  }, [loadSemantic, view]);

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
  const deepModels = useMemo(() => models.filter((model) => model.role === "deep"), [models]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileHelp(t("profileSaving"));
    try {
      const response = await sendMessage<{ profile?: Profile; error?: string }>({ type: "SET_PROFILE_LABEL", label: profileLabel });
      const error = responseError(response);
      if (error) throw new Error(error);
      if (response.profile) {
        setProfile(response.profile);
        setProfileLabel(response.profile.profileLabel ?? "");
      }
      setProfileHelp(t("profileSaved"));
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
      next ? t("enableSemanticBusy") : t("disableSemanticBusy"),
    );
  }

  function setStrategyPreference(strategy: string) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled: true, modelId: activeModelId, strategyPreference: strategy },
      t("strategySet", translateStrategy(strategy)),
    );
  }

  function setAgentResultCount(count: number) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled, modelId: activeModelId, agentResultCount: count },
      t("resultCountSet", String(count)),
    );
  }

  function setAgentResultDetail(detail: string) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled, modelId: activeModelId, agentResultDetail: detail },
      t("resultDetailSet", translateStrategy(detail)),
    );
  }

  function setEmbeddingDims(model: SemanticModel, dims: number) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled: true, modelId: model.id, embeddingDims: dims, preload: true },
      t("dimensionSet", String(dims)),
    );
  }

  function useModel(model: SemanticModel) {
    void updateSemantic(
      { type: "SET_SEMANTIC_SETTINGS", enabled: true, ...(model.role === "deep" ? { deepModelId: model.id } : { modelId: model.id }), preload: true },
      t("switchModel", model.label),
    );
  }

  function prepareModel(model: SemanticModel) {
    void updateSemantic({ type: "PREPARE_SEMANTIC_MODEL", modelId: model.id }, t("downloadingModel", model.label));
  }

  function deleteModel(model: SemanticModel) {
    if (window.confirm(t("deleteModelConfirm", model.label))) {
      void updateSemantic({ type: "DELETE_SEMANTIC_MODEL", modelId: model.id }, t("deletingModel", model.label));
    }
  }

  function renderModelCard(model: SemanticModel) {
    const isAdaptive = model.role !== "deep";
    const isActive = model.id === (isAdaptive ? activeModelId : settings.deepModelId);
    const cached = model.cache?.cached === true;
    const busyForModel = semanticBusy || (loading && load?.modelId === model.id);
    const dims = model.supportedDimensions ?? [];
    return (
      <div key={model.id} className={`model-card${isActive ? " active" : ""}`} data-model-id={model.id}>
        <div className="model-head">
          <span className="model-name">{model.label}</span>
          {model.default === true ? <span className="badge badge-default">{t("defaultLabel")}</span> : null}
          <span className={`badge ${cached ? "badge-ok" : "badge-neutral"}`}>{cached ? t("ready") : t("notDownloaded")}</span>
        </div>
        <div className="model-meta">
          {model.parameters ?? "n/a"} · {model.dimensions ?? "n/a"}-dim · ctx {model.contextLength ?? "512"}
          {isAdaptive ? "" : ` · ${t("deepSearchOnly")}`}
        </div>
        <div className="model-desc">{model.description ? (knownModelDescriptions.has(model.description) ? t(knownModelDescriptions.get(model.description)!) : model.description) : t("localRetrievalModel")}</div>
        {model.benchmark?.value ? <div className="model-bench">{model.benchmark.label}: {model.benchmark.value}</div> : null}
        {isAdaptive && dims.length > 0 ? (
          <div className="dim-selector" role="radiogroup" aria-label={t("embeddingLabel", model.label)}>
            {dims.map((dim) => (
              <button
                key={dim}
                type="button"
                role="radio"
                aria-checked={model.dimensions === dim}
                className={`dim-option${model.dimensions === dim ? " selected" : ""}`}
                disabled={busyForModel}
                onClick={() => setEmbeddingDims(model, dim)}
              >
                {dim}
              </button>
            ))}
            <span className="dim-note">{t("recommendedDim", String(model.defaultDimensions))}</span>
          </div>
        ) : null}
        <div className="model-actions">
          {isActive ? (
            <span className="model-active-note" aria-label={t("activeModel")}>{t("active")}</span>
          ) : null}
          {!isActive ? (
            <button
              type="button"
              className="button-use"
              disabled={busyForModel}
              onClick={() => useModel(model)}
            >
              {t("useModel")}{" "}</button>
          ) : null}
          {!isAdaptive ? (
            <span className="model-active-note">{t("onDemand")}</span>
          ) : null}
          <button
            type="button"
            className="button-prepare"
            disabled={busyForModel}
            onClick={() => prepareModel(model)}
          >
            {cached ? t("redownload") : t("download")}
          </button>
          <button
            type="button"
            className="button-delete"
            disabled={busyForModel || !cached}
            onClick={() => deleteModel(model)}
          >
            {t("delete")}{" "}</button>
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
      {view === "profiles" ? <>
      <details className="card connection-details" aria-labelledby="connection-title">
        <summary><h2 id="connection-title">{t("connectionDetails")}</h2></summary>
        <dl id="connection-list">
          <div>
            <dt>{t("status")}</dt>
            <dd id="status-detail">{statusText(status)}</dd>
          </div>
          <div>
            <dt>{t("host")}</dt>
            <dd id="host">{status.hostName ?? "com.opencode.browser.plugin"}</dd>
          </div>
          <div>
            <dt>{t("lastCheck")}</dt>
            <dd id="last-checked">{status.lastChecked ? new Date(status.lastChecked).toLocaleString() : "-"}</dd>
          </div>
          <div>
            <dt>{t("profileId")}</dt>
            <dd id="profile-id" className="mono profile-id-row">
              <span className="mono-value">{displayedProfileId || t("profileChecking")}</span>
              <button
                type="button"
                className="button-mini"
                onClick={() => {
                  if (profileIdRevealed) setProfileIdRevealed(null);
                  else void revealProfileId();
                }}
              >
                {profileIdRevealed ? t("hide") : t("reveal")}
              </button>
              <button type="button" className="button-mini" onClick={() => void copyProfileId()}>{t("copy")}</button>
            </dd>
          </div>
        </dl>
      </details>

      <div className="card" aria-labelledby="profile-title">
        <h2 id="profile-title">{t("chooseProfile")}</h2>
        <label htmlFor="connected-profile">{t("connectedProfiles")}</label>
        <select id="connected-profile" value={selectedProfile} onChange={(event) => setSelectedProfile(event.target.value)}>
          {connectedProfiles?.profiles.filter((item) => item.connected).map((item, index) => <option key={item.profileId} value={item.profileId}>{item.profileLabel || item.browserName || t("profileNumber", String(index + 1))}{item.profileId === connectedProfiles.currentProfileId ? t("thisProfileSuffix") : ""}</option>)}
        </select>
        <p className="help-note">{t("selectorHelp")}</p>
        <button className="button" type="button" disabled={!selectedProfile} onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ profile: selectedProfile })).then(() => setProfileHelp(t("copySelectorReady")), () => setProfileHelp(t("clipboardUnavailable"))); }}>{t("copySelector")}</button>
        <details className="advanced-details"><summary>{t("renameProfile")}</summary>
        <form id="profile-form" onSubmit={saveProfile}>
          <label htmlFor="profile-label">{t("profileLabel")}</label>
          <div className="input-row">
            <input
              id="profile-label"
              name="profile-label"
              type="text"
              maxLength={80}
              placeholder={t("exampleLabels")}
              value={profileLabel}
              onChange={(event) => setProfileLabel(event.target.value)}
            />
            <button type="submit" className="button button-primary" disabled={profileBusy}>{t("save")}</button>
          </div>
        </form>
        </details>
        <p id="profile-help" className="help-note" role="status">{profileHelp}</p>
      </div>
      </> : <>

      <details className="card search-settings" aria-labelledby="semantic-title">
        <summary><h2 id="semantic-title">{t("localSearchModels")}</h2></summary>
        <div className="semantic-toggle-row">
          <div className="semantic-toggle-copy">
            <span className="semantic-toggle-title">{t("searchMeaning")}</span>
            <span className="semantic-toggle-sub">{t("searchHelp")}</span>
          </div>
          <button
            id="semantic-enabled"
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("enableSemantic")}
            className={`switch${enabled ? " on" : ""}`}
            disabled={semanticBusy}
            onClick={() => toggleSemantic(!enabled)}
          >
            <span className="switch-knob" />
          </button>
        </div>
        <p className="help-note">{t("autoSearchHelp")}</p>
        <details className="advanced-details"><summary>{t("advancedSearch")}</summary>
        <div className="strategy-row" role="radiogroup" aria-label={t("searchMode")}>
          <span className="strategy-label">{t("searchMode")}</span>
          {["auto", "semantic", "lexical", "deep"].map((strategy) => (
            <button
              key={translateStrategy(strategy)}
              type="button"
              role="radio"
              aria-checked={(settings.strategyPreference ?? "auto") === strategy}
              className={`strategy-option${(settings.strategyPreference ?? "auto") === strategy ? " selected" : ""}`}
              disabled={semanticBusy || !enabled}
              onClick={() => setStrategyPreference(strategy)}
            >
              {strategy}
            </button>
          ))}
        </div>
        <div>
          <div className="advanced-row">
            <span className="advanced-label">{t("agentCount")}</span>
            <div role="radiogroup" aria-label={t("agentCount")}>
              {[3, 5, 8, 12, 20].map((count) => (
                <button
                  key={count}
                  type="button"
                  role="radio"
                  aria-checked={(settings.agentResultCount ?? 5) === count}
                  className={`strategy-option${(settings.agentResultCount ?? 5) === count ? " selected" : ""}`}
                  disabled={semanticBusy}
                  onClick={() => setAgentResultCount(count)}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
          <div className="advanced-row">
            <span className="advanced-label">{t("resultDetail")}</span>
            <div role="radiogroup" aria-label={t("resultDetail")}>
              {["lean", "compact", "debug"].map((detail) => (
                <button
                  key={translateStrategy(detail)}
                  type="button"
                  role="radio"
                  aria-checked={(settings.agentResultDetail ?? "lean") === detail}
                  className={`strategy-option${(settings.agentResultDetail ?? "lean") === detail ? " selected" : ""}`}
                  disabled={semanticBusy}
                  onClick={() => setAgentResultDetail(detail)}
                >
                  {detail}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div id="semantic-model-list" className="model-list" aria-label={t("retrievalModels")}>
          {semantic?.catalogStatus === "invalid_custom_catalog" && <p role="alert" className="help-note">{t("catalogInvalid")}</p>}
          {adaptiveModels.map(renderModelCard)}
          {deepModels.map(renderModelCard)}
        </div>
        </details>
        <p id="semantic-help">{semanticHelp}</p>
        <details id="semantic-dev-details" className="dev-details">
          <summary>{t("developerDetails")}</summary>
          <div className="dev-details-row">
            <span className="dev-details-label">{t("cacheLocation")}</span>
            <span className="dev-details-value">{t("localModelCache")}</span>
            <button type="button" className="button-mini" onClick={() => void copyCachePath()}>
              {cacheCopyState === "copied" ? t("copied") : cacheCopyState === "error" ? t("failed") : t("copyPath")}
            </button>
          </div>
        </details>
      </details>
      </>}
    </section>
  );
}
