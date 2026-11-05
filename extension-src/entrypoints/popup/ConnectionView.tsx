import { useCallback,useEffect,useMemo,useState,type FormEvent } from "react";
import { t } from "../../i18n";
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

const knownModelDescriptions = new Map<string, string>([
  ["Default English page retrieval with a compact 22.6M parameter Snowflake embedding model. Use lexical or auto explicitly when lower latency is preferred.", "modelXs"],
  ["Larger Snowflake retrieval model with stronger relevance at 768 dimensions. Choose it when quality matters more than local disk and memory footprint.", "modelM"],
  ["Multilingual on-device embedding model with Matryoshka output dimensions (128/256/512/768). 256 dimensions is the recommended size-to-quality balance.", "modelGemma"],
  ["Current local retrieval stack: Qwen3 embeddings for broad page search plus Qwen3 reranking for the final relevant context.", "modelQwen"],
]);
const strategyKeys: Record<string, string> = { auto: "strategyAuto", semantic: "strategySemantic", lexical: "strategyLexical", deep: "strategyDeep", lean: "detailLean", compact: "detailCompact", debug: "detailDebug" };
const translateStrategy = (value: string) => strategyKeys[value] ? t(strategyKeys[value]!) : value;

type ConnectionViewProps = { status: NativeStatus; view?: "profiles" | "settings"; onProfileSaved?: (profile: Profile) => void };

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

export default function ConnectionView({ status, view = "profiles", onProfileSaved }: ConnectionViewProps): React.JSX.Element {
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
        onProfileSaved?.(response.profile);
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

  function renderModelCard(model: SemanticModel, advanced = false) {
    const isAdaptive = model.role !== "deep", isActive = model.id === (isAdaptive ? activeModelId : settings.deepModelId);
    const cached = model.cache?.cached === true, busyForModel = semanticBusy || loading;
    return <div className="model-card" key={model.id} data-model-id={model.id}>
      {!advanced && <div className="model-compact-row"><div><span className="model-name">{model.label}</span><small>{t(isActive ? "currentSearchModel" : cached ? "ready" : "notDownloaded")}</small></div>
        {isActive && cached ? <span className="online-text">{t("ready")}</span> : <button type="button" className="button" disabled={busyForModel} onClick={() => prepareModel(model)}>{t(loading && load?.modelId === model.id ? "downloading" : "download")}</button>}
      </div>}
      {loading && load?.modelId === model.id && <div className="model-progress" role="progressbar" aria-label={t("downloadingModel", model.label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={load.progress}><div className="model-progress-fill" style={{ width: `${Math.max(4, Math.min(100, load.progress ?? 4))}%` }} /></div>}
      {advanced && <details className="model-options"><summary>{t("modelOptions", model.label)}</summary>
        <p className="model-desc">{model.description ? knownModelDescriptions.has(model.description) ? t(knownModelDescriptions.get(model.description)!) : model.description : t("localRetrievalModel")}</p>
        <p className="model-meta">{model.parameters} · {model.dimensions}-dim</p>
        {(model.supportedDimensions?.length ?? 0) > 0 && <label>{t("embeddingLabel", model.label)}<select disabled={busyForModel} value={settings.embeddingDims ?? model.dimensions} onChange={event => setEmbeddingDims(model, Number(event.target.value))}>{model.supportedDimensions?.map(dim => <option key={dim} value={dim}>{dim}</option>)}</select></label>}
        <div className="model-actions">{!isActive && <button type="button" className="button" disabled={busyForModel} onClick={() => useModel(model)}>{t("useModel")}</button>}<button type="button" className="button" disabled={busyForModel} onClick={() => prepareModel(model)}>{t(cached ? "redownload" : "download")}</button><button type="button" className="button" disabled={busyForModel || !cached} onClick={() => deleteModel(model)}>{t("delete")}</button></div>
      </details>}
    </div>;
  }

  return <section id="view-connection" className="view">
    {view === "profiles" ? <>
      <form id="profile-form" className="profile-form" onSubmit={saveProfile}>
        <label htmlFor="profile-label">{t("profileLabel")}</label>
        <input id="profile-label" name="profile-label" maxLength={80} value={profileLabel} disabled={profileBusy} onChange={event => setProfileLabel(event.target.value)} />
        <p className="help-note">{t("profileLabelLocal")}</p>
        <div className="split-actions"><p id="profile-help" className="help-note" role="status">{profileHelp}</p><button type="submit" className="button" disabled={profileBusy}>{t("saveLabel")}</button></div>
      </form><hr />
      <h2>{t("agentSelector")}</h2><p className="help-note">{t("selectorHelp")}</p>
      <button className="button" type="button" disabled={!profile} onClick={() => { void (async () => { const id = profile?.profileId ?? (await sendMessage<{ profile?: Profile }>({ type: "GET_PROFILE_DETAILS" })).profile?.profileId; if (!id) throw new Error("unavailable"); await navigator.clipboard.writeText(JSON.stringify({ profile: id })); })().then(() => setProfileHelp(t("copySelectorReady")), () => setProfileHelp(t("clipboardUnavailable"))); }}>{t("copySelectorAction")}</button><hr />
      <details className="advanced-details"><summary>{t("profileIdentifier")}</summary>
        <p className="identifier-value">{displayedProfileId}</p><div className="split-actions"><button type="button" className="button" onClick={() => { if (profileIdRevealed) setProfileIdRevealed(null); else void revealProfileId(); }}>{t(profileIdRevealed ? "hide" : "reveal")}</button><button type="button" className="button" onClick={() => void copyProfileId()}>{t("copy")}</button></div>
      </details>
      <details className="connection-details"><summary>{t("connectionDetails")}</summary><dl className="bridge-details"><div><dt>{t("status")}</dt><dd>{statusText(status)}</dd></div><div><dt>{t("host")}</dt><dd>{status.hostName ?? "com.opencode.browser.plugin"}</dd></div><div><dt>{t("lastCheck")}</dt><dd>{status.lastChecked ? new Date(status.lastChecked).toLocaleString() : "—"}</dd></div></dl></details>
      <p className="help-note">{t("labelsStoredLocally")}</p>
    </> : <div className="search-settings" aria-label={t("localSearchModels")}>
      <div className="semantic-toggle-row"><div><span className="semantic-toggle-title">{t("localSearch")}</span><span className="semantic-toggle-sub">{t("localSearchHelp")}</span></div><button id="semantic-enabled" type="button" role="switch" aria-checked={enabled} aria-label={t("enableSemantic")} className={`switch${enabled ? " on" : ""}`} disabled={!semantic || semanticBusy} onClick={() => toggleSemantic(!enabled)}><span /></button></div>
      <p className="help-note">{t("modelsRunLocally")}</p>
      <label className="field-label" htmlFor="search-model">{t("searchModel")}</label><select id="search-model" value={activeModelId ?? ""} disabled={!semantic || semanticBusy || loading} onChange={event => { const model = adaptiveModels.find(model => model.id === event.target.value); if (model) useModel(model); }}>{!activeModelId && <option value="">{t("loadingModels")}</option>}{adaptiveModels.map(model => <option key={model.id} value={model.id}>{model.label}{model.cache?.cached ? ` · ${t("ready")}` : ""}</option>)}</select>
      <div id="semantic-model-list" className="model-list">{semantic?.catalogStatus === "invalid_custom_catalog" && <p role="alert">{t("catalogInvalid")}</p>}{adaptiveModels.map(model => renderModelCard(model))}</div>
      <details className="advanced-details"><summary>{t("advancedSearch")}</summary>
        <p className="help-note">{t("controlAgentContext")}</p>
        <label className="field-label" htmlFor="search-mode">{t("searchMode")}</label><select id="search-mode" disabled={semanticBusy || !enabled} value={settings.strategyPreference ?? "auto"} onChange={event => setStrategyPreference(event.target.value)}>{["auto", "semantic", "lexical", "deep"].map(strategy => <option value={strategy} key={strategy}>{translateStrategy(strategy)}</option>)}</select>
        <label className="field-label" htmlFor="result-count">{t("agentCount")}</label><select id="result-count" value={settings.agentResultCount ?? 5} disabled={semanticBusy} onChange={event => setAgentResultCount(Number(event.target.value))}>{[3, 5, 8, 12, 20].map(count => <option key={count} value={count}>{count}</option>)}</select>
        <label className="field-label" htmlFor="result-detail">{t("resultDetail")}</label><select id="result-detail" value={settings.agentResultDetail ?? "lean"} disabled={semanticBusy} onChange={event => setAgentResultDetail(event.target.value)}>{["lean", "compact", "debug"].map(detail => <option key={detail} value={detail}>{translateStrategy(detail)}</option>)}</select>
        {adaptiveModels.map(model => renderModelCard(model, true))}
        <details className="advanced-details"><summary>{t("deepSearchModels")}</summary>{deepModels.map(model => renderModelCard(model, true))}</details>
      </details>
      <p id="semantic-help" className="help-note" role="status">{semanticHelp}</p>
      <details id="semantic-dev-details" className="dev-details"><summary>{t("developerDetails")}</summary><p className="help-note">{t("localModelCache")}</p><button type="button" className="button" onClick={() => void copyCachePath()}>{t(cacheCopyState === "copied" ? "copied" : cacheCopyState === "error" ? "failed" : "copyPath")}</button></details>
    </div>}
  </section>;
}
