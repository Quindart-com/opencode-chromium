import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Renders the README benchmark summary from the committed reports. It reads
// only assets/benchmarks/*.json and makes no measurements or network calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "assets/benchmarks");
const accuracy = JSON.parse(fs.readFileSync(path.join(dir, "accuracy.json"), "utf8"));
const pipeline = JSON.parse(fs.readFileSync(path.join(dir, "pipeline.json"), "utf8"));

interface Row { label: string; detail: string; correct: number; total: number; latency: string }
interface Section { title: string; note: string; rows: Row[] }

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1]! : 0;
};
const ms = (value: number) => value < 10 ? `${value.toFixed(2)} ms` : `${Math.round(value)} ms`;

const lexical = accuracy.arms.find((arm: any) => arm.arm === "lexical");
const bucket = (name: string) => lexical.samples.filter((sample: any) => sample.bucket === name);
const pipelineBucket = (exact: boolean) => pipeline.samples.filter((sample: any) => sample.task.startsWith("paraphrase") !== exact);
const count = (rows: any[], key = "correct") => rows.filter(row => row[key]).length;

const sections: Section[] = [
  {
    title: "Target selection",
    note: `In-process ranking · ${accuracy.fixture.queries} queries · ${accuracy.fixture.units}-control settings page`,
    rows: [
      { label: "Exact labels", detail: "query matches the visible text", correct: count(bucket("exact")), total: bucket("exact").length,
        latency: ms(median(bucket("exact").map((s: any) => s.wallMs))) },
      { label: "Paraphrased intents", detail: "same goal, different words", correct: count(bucket("paraphrase")), total: bucket("paraphrase").length,
        latency: ms(lexical.latency.paraphraseP50Ms) },
      { label: "Answer in candidate pool", detail: "top 16 handed to a decision model", correct: lexical.accuracy.total.recall16, total: lexical.accuracy.total.tasks,
        latency: "" },
      // Present only when the report was recorded with --cloud.
      ...accuracy.arms.filter((arm: any) => arm.arm !== "lexical").map((arm: any) => ({
        label: `All queries · ${arm.arm}`, detail: `${arm.decisions.paidCalls} paid requests · ${arm.decisions.fallback} fallbacks`,
        correct: arm.accuracy.total.correct, total: arm.accuracy.total.tasks, latency: ms(arm.latency.paraphraseP50Ms),
      })),
    ],
  },
  {
    title: "Full browser pipeline",
    note: `Chromium + extension + native host + SDK · search, click, verify · ${pipeline.rounds} rounds`,
    rows: [
      { label: "Exact labels", detail: "found, clicked and verified", correct: count(pipelineBucket(true)), total: pipelineBucket(true).length,
        latency: ms(median(pipelineBucket(true).map((s: any) => s.wallMs))) },
      { label: "Paraphrased intents", detail: "local search only, no model", correct: count(pipelineBucket(false)), total: pipelineBucket(false).length,
        latency: ms(median(pipelineBucket(false).map((s: any) => s.wallMs))) },
    ],
  },
];

const themes = {
  light: { background: "#ffffff", border: "#d1d9e0", title: "#1f2328", text: "#1f2328", faint: "#59636e", track: "#eff2f5", bar: "#0969da", value: "#0969da" },
  dark: { background: "#0d1117", border: "#30363d", title: "#e6edf3", text: "#e6edf3", faint: "#9198a1", track: "#21262d", bar: "#4493f8", value: "#4493f8" },
};
const esc = (text: unknown) => String(text).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function render(theme: typeof themes.light) {
  const width = 760, left = 28, barX = 300, barW = 280, rowH = 46;
  let y = 92;
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(`<text x="${left}" y="${y}" font-size="14" font-weight="700" fill="${theme.title}">${esc(section.title)}</text>`,
      `<text x="${left}" y="${y + 18}" font-size="11.5" fill="${theme.faint}">${esc(section.note)}</text>`,
      `<text x="${width - left}" y="${y + 18}" text-anchor="end" font-size="11" fill="${theme.faint}">median time</text>`);
    y += 40;
    for (const row of section.rows) {
      const fill = row.total ? barW * row.correct / row.total : 0;
      parts.push(`<text x="${left}" y="${y + 5}" font-size="13" font-weight="600" fill="${theme.text}">${esc(row.label)}</text>`,
        `<text x="${left}" y="${y + 21}" font-size="11" fill="${theme.faint}">${esc(row.detail)}</text>`,
        `<rect x="${barX}" y="${y - 6}" width="${barW}" height="14" rx="7" fill="${theme.track}"/>`,
        fill ? `<rect x="${barX}" y="${y - 6}" width="${fill.toFixed(1)}" height="14" rx="7" fill="${theme.bar}"/>` : "",
        `<text x="${barX + barW + 14}" y="${y + 5}" font-size="13" font-weight="700" fill="${theme.value}">${row.correct}/${row.total}</text>`,
        `<text x="${width - left}" y="${y + 5}" text-anchor="end" font-size="12.5" fill="${theme.text}">${esc(row.latency || "—")}</text>`);
      y += rowH;
    }
    y += 22;
  }
  const height = y - 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Benchmark summary for v${esc(accuracy.packageVersion)}: ${sections.flatMap(s => s.rows.map(r => `${s.title} ${r.label} ${r.correct} of ${r.total}`)).join(", ")}">
<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.background}" stroke="${theme.border}"/>
<text x="${left}" y="38" font-size="18" font-weight="700" fill="${theme.title}">Benchmarks · v${esc(accuracy.packageVersion)}</text>
<text x="${left}" y="60" font-size="12" fill="${theme.faint}">Synthetic fixtures · local lexical search · no cloud calls · measured ${esc(date(accuracy.generatedAt))}</text>
${parts.filter(Boolean).join("\n")}
</g>
</svg>
`;
}

fs.writeFileSync(path.join(dir, "summary.svg"), render(themes.light));
fs.writeFileSync(path.join(dir, "summary-dark.svg"), render(themes.dark));
console.log(JSON.stringify(sections.map(s => ({ section: s.title, rows: s.rows.map(r => `${r.label}: ${r.correct}/${r.total} ${r.latency}`) })), null, 2));
