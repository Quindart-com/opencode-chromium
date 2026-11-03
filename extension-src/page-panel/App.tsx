import { useRef,useState } from "react";
import { browser } from "wxt/browser";
import { harnessDefinitions,harnessLabels } from "../../src/shared/harnesses.ts";
import { t } from "../i18n.ts";
import UsageTrend from "../entrypoints/popup/UsageTrend.tsx";
import PanelIcon from "../entrypoints/popup/PanelIcon.tsx";
import type { PagePanelSnapshot,PagePanelView,PagePanelUsage } from "./protocol.ts";

type Props = {
  snapshot: PagePanelSnapshot | null; unavailable: boolean; solid: boolean; forcedSolid: boolean; layoutChanged(): void;
  setUsage(usage: PagePanelUsage): void;
  open(view: PagePanelView): void; close(): void; minimized: boolean;
  minimize(): void; move(event: React.PointerEvent<HTMLButtonElement>): void;
  nudge(event: React.KeyboardEvent<HTMLButtonElement>): void;
};
const displayNumber = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: value > 999999 ? "compact" : "standard" }).format(value);

export default function PagePanelApp(props: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PagePanelView>("overview");
  const [opaqueOverride, setOpaque] = useState<boolean | null>(null);
  const opaque = props.forcedSolid || (opaqueOverride ?? props.solid);
  const [usage, setUsage] = useState<PagePanelUsage>({ period: "7d", provider: "current" });
  const changeUsage = (next: PagePanelUsage) => { setUsage(next); props.setUsage(next); };
  const { snapshot, unavailable, open } = props;
  const views = ["overview", "profiles", "settings"] as const;
  const changeView = (next: PagePanelView) => { setView(next); if (scroll.current) scroll.current.scrollTop = 0; props.layoutChanged(); };
  const tabKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: number) => {
    const index = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (current + 1) % 3 : event.key === "ArrowLeft" ? (current + 2) % 3 : null;
    if (index === null) return;
    event.preventDefault(); changeView(views[index]!);
    (event.currentTarget.parentElement?.children[index] as HTMLButtonElement | undefined)?.focus();
  };
  return <div className={`board${opaque ? " opaque" : ""}`} role="region" aria-label="OpenCode Browser">
    <header className="board-header">
      <img className="brand-logo" src={browser.runtime.getURL("/images/icon48.png")} alt="" width="32" height="32" />
      <div className="brand-copy"><h1><span className="copy">OpenCode Browser</span></h1><p><span className="copy">v{browser.runtime.getManifest().version} · {t("localAutomation")}</span></p></div>
      <div className="board-tools">
        <button type="button" aria-label={t("pagePanelMove")} onPointerDown={props.move} onKeyDown={props.nudge}><PanelIcon name="move" /></button>
        <button type="button" aria-label={t(props.minimized ? "pagePanelRestore" : "pagePanelMinimize")} onClick={props.minimize}><PanelIcon name="collapse" /></button>
        <button type="button" aria-label={t("pagePanelClose")} onClick={props.close}><PanelIcon name="close" /></button>
      </div>
    </header>
    {!props.minimized && <>
      <nav className="board-tabs" role="tablist" aria-label={t("extensionViews")}>{views.map((name, index) => <button type="button" key={name} role="tab" aria-selected={view === name} aria-controls={`page-panel-${name}`} id={`page-tab-${name}`} tabIndex={view === name ? 0 : -1} onClick={() => changeView(name)} onKeyDown={event => tabKey(event, index)}><PanelIcon name={name} /><span className="copy">{t(name)}</span></button>)}</nav>
      <div className="board-scroll" ref={scroll}>
        {unavailable && <p role="status" className="notice"><span className="copy">{t("usageUnavailable")}</span></p>}
        {views.map(name => <div key={name} id={`page-panel-${name}`} role="tabpanel" aria-labelledby={`page-tab-${name}`} hidden={view !== name}>
          {name === "overview" && <>
            <div className="board-intro"><h2>{t("readyWhenYouAre")}</h2></div>
            <section className="glass-card" aria-labelledby="board-connections">
              <div className="section-heading"><h2 id="board-connections"><span className="copy">{t("harnessConnections")}</span></h2><span className="copy profile">{t("thisProfile")}</span></div>
              <p className="bridge"><i className={snapshot?.connected ? "online" : "offline"} /><span className={snapshot?.connected ? "copy status-connected" : "copy"}>{t(!snapshot ? "checkingConnection" : snapshot.connected ? "bridgeReady" : "bridgeUnavailable")}</span></p>
              <ul className="harnesses">{snapshot?.harnesses.map(harness => <li key={harness.id}>
                <span className="harness-icon" aria-hidden="true"><span>{harnessLabels[harness.id].slice(0, 1)}</span><img src={new URL(harnessDefinitions[harness.id].icon, browser.runtime.getURL("/")).href} alt="" onError={event => { event.currentTarget.hidden = true; }} /></span>
                <div className="harness-identity"><strong><span className="copy">{harnessLabels[harness.id]}</span></strong><small><span className={harness.connected ? "copy status-connected" : "copy"}><i className={harness.connected ? "online" : "offline"} />{t(harness.connected ? "statusConnected" : "statusDisconnected")}{harness.version ? ` · v${harness.version}` : ""}</span></small></div>
                <button type="button" onClick={() => open("overview")} aria-label={t(harness.connected ? "reconnectNamed" : "connectNamed", harnessLabels[harness.id])}><span className="copy">{t(harness.connected ? "reconnectAgent" : "connectAgent")}</span></button>
              </li>)}</ul>
              {snapshot && !snapshot.harnesses.length && <p><span className="copy">{t(snapshot.connected ? snapshot.harnessesKnown ? "noHarnessesDetected" : "pagePanelStatusUnavailable" : "runtimeInstall")}</span></p>}
              <details><summary><span className="copy">{t("connectionTroubleshooting")}</span></summary><p><span className="copy">{t("pagePanelProtected")}</span></p><button type="button" onClick={() => open("overview")}><span className="copy">{t("openPanel")}</span><PanelIcon name="external" /></button></details>
            </section>
            <section className="glass-card" aria-labelledby="board-decisions">
              <div className="section-heading"><h2 id="board-decisions"><span className="copy">{t("decisionAssistance")}</span></h2><button type="button" onClick={() => open("settings")}><span className="copy">{t("configure")}</span></button></div>
              <p><span className="copy">{t(!snapshot || snapshot.assistance === null ? "usageUnavailable" : snapshot.assistance ? "statusConnected" : "assistanceOff")}</span></p>
              <div className="usage-filters"><label><span className="copy">{t("usageProvider")}</span><select aria-label={t("usageProvider")} value={usage.provider} onChange={event => changeUsage({ ...usage, provider: event.target.value as PagePanelUsage["provider"] })}>
                <option value="current">{t("usageCurrentProvider")}</option><option value="all">{t("usageAllProviders")}</option><option value="openrouter:jev">OpenRouter · Jev</option><option value="typesafe:jev">TypeSafe · Jev</option><option value="openai:openai-decisions">OpenAI · Luna</option><option value="openrouter:openai-decisions">OpenRouter · Luna</option>
              </select></label><label><span className="copy">{t("usagePeriod")}</span><select aria-label={t("usagePeriod")} value={usage.period} onChange={event => changeUsage({ ...usage, period: event.target.value as PagePanelUsage["period"] })}>{[["7d", "usageLast7"], ["30d", "usageLast30"], ["last-week", "usageLastWeek"], ["last-year", "usageLastYear"], ["all", "usageAllTime"]].map(([id, key]) => <option key={id} value={id}>{t(key!)}</option>)}</select></label></div>
              <dl className="metrics">{[["usageInput", snapshot?.usage?.input], ["usageOutput", snapshot?.usage?.output], ["calls", snapshot?.usage?.calls], ["reportedCost", snapshot?.usage?.cost === null ? t("notReported") : snapshot?.usage?.cost === undefined ? "—" : `$${snapshot.usage.cost.toFixed(6)}`]].map(([label, value]) => <div key={label as string}><dt><span className="copy">{t(label as string)}</span></dt><dd><span className="copy">{typeof value === "string" ? value : displayNumber(value as number | undefined)}</span></dd></div>)}</dl>
              {snapshot?.usage && <UsageTrend days={snapshot.usage.days ?? []} />}<button type="button" onClick={() => open("overview")}><span className="copy">{t("usageServices")}</span><PanelIcon name="external" /></button>
            </section>
            <section className="glass-card"><h2><span className="copy">{t("replayMemory")}</span></h2><p><span className="copy">{t(!snapshot ? "memoryChecking" : !snapshot.memory ? "memoryUnavailable" : snapshot.memory.enabled ? "memoryOn" : "memoryOff")}</span></p><details><summary><span className="copy">{t("activityStats")}</span></summary><dl className="metrics"><div><dt><span className="copy">{t("uniqueActions")}</span></dt><dd><span className="copy">{displayNumber(snapshot?.memory?.actions)}</span></dd></div><div><dt><span className="copy">{t("recipes")}</span></dt><dd><span className="copy">{displayNumber(snapshot?.memory?.recipes)}</span></dd></div></dl><button type="button" onClick={() => open("overview")}><span className="copy">{t("openPanel")}</span></button></details></section>
          </>}
          {name === "profiles" && <section className="glass-card"><h2><span className="copy">{t("profiles")}</span></h2><p><span className="copy">{t("thisProfile")}</span></p><p><span className="copy">{t("pagePanelProtected")}</span></p><button type="button" className="primary" onClick={() => open("profiles")}><span>{t("pagePanelManageProfiles")}</span><PanelIcon name="external" /></button></section>}
          {name === "settings" && <>
            <section className="glass-card"><h2><span className="copy">{t("settings")}</span></h2><p><span className="copy">{t("pagePanelProtected")}</span></p><ul className="settings-list">{["decisionAssistance", "fileUploads", "actionMemory", "storageLimit", "cleanup", "updates", "localSearchModels"].map(key => <li key={key}><button type="button" onClick={() => open("settings")}><span className="copy">{t(key)}</span><PanelIcon name="external" /></button></li>)}</ul></section>
          </>}
        </div>)}
        <footer><label><input type="checkbox" checked={opaque} disabled={props.forcedSolid} onChange={event => setOpaque(event.target.checked)} /><span className="copy">{t("pagePanelOpaque")}</span></label><button type="button" onClick={() => open(view)}><span className="copy">{t("openPanel")}</span><PanelIcon name="external" /></button></footer>
      </div>
    </>}
  </div>;
}
