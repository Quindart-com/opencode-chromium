import { record } from "../../shared/values.ts";
import { domSnapshotExpression,pageSearchUnitsExpression } from "../operations/snapshot-expressions.ts";
import { elementId,type LadybirdSession,type LadybirdTab } from "./session.ts";

export function ladybirdNodeId(ref: number) { return "ladybird:" + ref; }

export async function observeLadybird(session: LadybirdSession, tab: LadybirdTab, scope: "viewport" | "page", snapshot = false) {
  const field = snapshot ? "nodes" : "units";
  const expression = snapshot ? domSnapshotExpression() : pageSearchUnitsExpression({ scope, maxUnits: 300 });
  // Serialize actual WebDriver elements in the same snapshot. The browser
  // rejects these references after detachment or navigation, even at the same URL.
  const page = record(await session.evaluate(
    "const page = " + expression + "; return {...page, elements: page." + field +
    ".map(node => window.__agentBrowserDomNodeMap.get(node.node_id)), text: (document.body?.innerText ?? '').slice(0, 12000)};",
  ));
  const elements = Array.isArray(page.elements) ? page.elements as unknown[] : [];
  const entries = (Array.isArray(page[field]) ? page[field] as unknown[] : []).flatMap((item, index) => {
    const id = elementId(elements[index]);
    if (!id) return [];
    const ref = session.remember(tab, id);
    return [{ ...record(item), node_id: ladybirdNodeId(ref), ref }];
  });
  if (typeof page.url === "string") tab.url = page.url;
  if (typeof page.title === "string") tab.title = page.title;
  return { url: tab.url, title: tab.title, text: String(page.text ?? ""), observation: page.observation, viewport: page.viewport, entries };
}

function entryLabel(entry: Record<string, unknown>) {
  return [...new Set([entry.name, entry.ariaName, entry.text].filter(value => typeof value === "string" && value.trim()))].join(" ").replace(/\s+/g, " ").slice(0, 240);
}

export function searchLadybird(entries: Awaited<ReturnType<typeof observeLadybird>>["entries"], query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.map(entry => {
    const content = [entryLabel(entry), record(entry).role, record(entry).kind, record(entry).selector].join(" ").toLowerCase();
    const score = words.filter(word => content.includes(word)).length + (content.includes(words.join(" ")) ? 1 : 0);
    return { entry, score };
  }).filter(item => item.score > 0).sort((left, right) => right.score - left.score).map(item => item.entry);
}

export function renderLadybirdView(page: Awaited<ReturnType<typeof observeLadybird>>, query: string, maxChars: number, wholePage: boolean) {
  const controls = searchLadybird(page.entries, query).filter(entry => record(entry).interactive === true);
  const lines = controls.map(entry => "[" + entry.ref + "] " + String(record(entry).kind ?? "element") + " " + entryLabel(entry));
  const text = wholePage && !query ? page.text : searchLadybird(page.entries, query)
    .filter(entry => record(entry).interactive !== true).map(entryLabel).filter(Boolean).join("\n");
  return [...lines, ...new Set(text.split("\n").filter(Boolean))].join("\n").slice(0, maxChars);
}
