import { useEffect,useId,useRef } from "react";
import { validVersion } from "../../../src/shared/semver.ts";
import { t } from "../../i18n";

export type MajorReview = { current: string | null; target: string | null; approve(): void };
export default function RuntimeApproval({ review, cancel }: { review: MajorReview; cancel(): void }) {
  const title = useId(), notNow = useRef<HTMLButtonElement>(null);
  const complete = validVersion(review.current) && validVersion(review.target);
  useEffect(() => { notNow.current?.focus(); }, []);
  return <section className="card major-review" aria-labelledby={title} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}>
    <p className="review-versions">{t("majorReviewVersions", [validVersion(review.current) ? review.current : t("memoryUnknown"), validVersion(review.target) ? review.target : t("memoryUnknown")])}</p>
    <h2 id={title}>{t("majorReviewTitle")}</h2>
    <p>{t("majorUpgradeConfirm")} <a href="https://quindart-com.github.io/opencode-chromium/updates/" target="_blank" rel="noopener noreferrer">{t("whatsNew")}</a></p>
    <p role="status">{t(complete ? "runtimeApprovalRequired" : "majorReviewUnavailable")}</p>
    <div className="review-actions">
      <button type="button" className="button button-primary" disabled={!complete} onClick={event => { if (event.nativeEvent.isTrusted && complete) review.approve(); }}>{t("majorApprove")}</button>
      <button type="button" ref={notNow} className="button" onClick={cancel}>{t("majorNotNow")}</button>
      <button type="button" className="button" onClick={cancel}>{t("majorBackSettings")}</button>
    </div>
  </section>;
}
