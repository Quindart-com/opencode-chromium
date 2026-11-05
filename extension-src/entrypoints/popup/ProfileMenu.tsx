import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { memoryCall, type MemoryProfiles, type Profile } from "./api";
import Icon from "./Icon";

export default function ProfileMenu({ profile, connected, onRename }: { profile: Profile | null; connected: boolean; onRename: () => void }) {
  const [open, setOpen] = useState(false), [profiles, setProfiles] = useState<MemoryProfiles | null>(null);
  const [selected, setSelected] = useState(""), [feedback, setFeedback] = useState("");
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    if (connected) void memoryCall<MemoryProfiles>("memory.profiles").then(value => {
      if (active) { setProfiles(value); setSelected(value.currentProfileId ?? ""); }
    }).catch(() => { if (active) setFeedback(t("profilesUnavailable")); });
    else { setProfiles(null); setSelected(""); setOpen(false); }
    return () => { active = false; };
  }, [connected]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const rows = profiles?.profiles.filter(row => row.connected) ?? [];
  return <div className="profile-menu" ref={container}>
    <button ref={trigger} className="profile-trigger" type="button" disabled={!connected} aria-expanded={open} aria-controls="profile-popover" onClick={() => setOpen(!open)}>
      <span>{profile?.profileLabel || t("thisBrowserShort")}{profile?.profileLabel ? ` · ${t("thisBrowserShort")}` : ""}</span><Icon name="chevron-down" />
    </button>
    {open && <div id="profile-popover" className="profile-popover">
      <p className="muted">{t("connectedProfiles")}</p>
      <div role="radiogroup" aria-label={t("chooseProfile")}>
        {rows.map((row, index) => <button className="profile-option" type="button" role="radio" aria-checked={selected === row.profileId} key={row.profileId} onClick={() => { setSelected(row.profileId); setFeedback(""); }} onKeyDown={event => {
          const offset = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 0;
          if (!offset) return; event.preventDefault();
          const next = (index + offset + rows.length) % rows.length; setSelected(rows[next]!.profileId);
          (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
        }}><span><strong>{row.profileId === profiles?.currentProfileId ? profile?.profileLabel || row.profileLabel || t("thisBrowserShort") : row.profileLabel || row.browserName || t("profileNumber", String(index + 1))}</strong><small>{t(row.profileId === profiles?.currentProfileId ? "thisBrowserShort" : "connectedBrowser")}</small></span>{selected === row.profileId && <Icon name="check" />}</button>)}
      </div>
      <p className="profile-selector-help">{t("profileMenuHelp")}</p>
      <div className="split-actions"><button className="button" type="button" disabled={!selected} onClick={() => void navigator.clipboard.writeText(JSON.stringify({ profile: selected })).then(() => setFeedback(t("copySelectorReady")), () => setFeedback(t("clipboardUnavailable")))}>{t("copySelectorAction")}</button><button className="text-button" type="button" onClick={onRename}>{t("renameThisProfile")}</button></div>
      <p role="status" className="feedback">{feedback}</p>
    </div>}
  </div>;
}
