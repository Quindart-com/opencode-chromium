// A text view of a page built from the browser's own DOMSnapshot. No script runs in
// the page, so sites that react to injected script or devtools cannot observe it, and
// it still answers for a hidden tab, where screenshots and pointer input stall.
//
// The view is plain lines rather than JSON so that a page costs a few hundred tokens:
//   [123] link "Frontend engineer" @850,228     controls: backend node id, kind, label, click point
//   Job description: build and ship ...          visible text blocks
// After the first read, a tab returns only what changed since its previous view.

type Rare<T> = { index: number[]; value?: T[] };
export interface SnapshotDocument {
  documentURL: number;
  title: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  contentWidth?: number;
  contentHeight?: number;
  nodes: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    nodeValue?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    inputValue?: Rare<number>;
    inputChecked?: Rare<never>;
    optionSelected?: Rare<never>;
    isClickable?: Rare<never>;
  };
  layout: { nodeIndex: number[]; styles: number[][]; bounds: number[][]; text: number[] };
  /** Rendered line fragments of text layout objects: the true on-screen reading order. */
  textBoxes?: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
}
export interface Snapshot { documents: SnapshotDocument[]; strings: string[] }
/** CSS-pixel viewport. `scale` converts snapshot layout units to CSS pixels (zoom-for-DSF lays out in device pixels). */
export interface Viewport { x: number; y: number; width: number; height: number; scale?: number }

/** Ratio of snapshot layout units to CSS pixels, from the document's content size. */
export function layoutScale(document: { contentWidth?: number; contentHeight?: number } | undefined, cssContent: { width?: number; height?: number } | undefined) {
  const ratios = [[document?.contentHeight, cssContent?.height], [document?.contentWidth, cssContent?.width]]
    .filter(([layout, css]) => typeof layout === "number" && typeof css === "number" && layout > 0 && css > 0)
    .map(([layout, css]) => layout! / css!);
  const ratio = ratios[0] ?? 1;
  return Math.abs(ratio - 1) < 0.02 || ratio < 0.25 || ratio > 8 ? 1 : ratio;
}
export interface ViewOptions { scope?: "viewport" | "page"; query?: string; maxChars?: number }
export interface ViewItem { key: string; line: string; ref?: number; y: number }
export interface NativeView { url: string; title: string; header: string; items: ViewItem[]; omitted: number; matched?: number }

/** Computed styles requested from DOMSnapshot.captureSnapshot, in this order. */
export const VIEW_STYLES = ["display", "visibility", "opacity"];

const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "canvas", "iframe", "object"]);
const INLINE = new Set(["inline", "contents", "inline-block", "inline-flex", "inline-grid", "ruby", ""]);
const ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell"]);
const TEXT_INPUTS = new Set(["", "text", "search", "email", "password", "number", "tel", "url", "date", "datetime-local", "month", "time", "week"]);
const CONTROL_LABEL = 80, TEXT_LABEL = 240;

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;
const WIDE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;

// Reads a block's text in on-screen order. Some sites shuffle text nodes in the DOM and
// position them with CSS so DOM order is unreadable; line, then x, restores reading order.
// CJK pieces join without a space.
function joinPieces(pieces: { text: string; box: { x: number; y: number; h: number } | null }[]) {
  const placed = pieces.every(piece => piece.box);
  const ordered = placed && pieces.length > 1
    ? pieces.map((piece, index) => ({ piece, index })).sort((a, b) => {
        const line = Math.max(4, Math.min(a.piece.box!.h, b.piece.box!.h) / 2);
        return Math.abs(a.piece.box!.y - b.piece.box!.y) > line ? a.piece.box!.y - b.piece.box!.y : a.piece.box!.x - b.piece.box!.x || a.index - b.index;
      }).map(entry => entry.piece)
    : pieces;
  let text = "";
  for (const { text: next } of ordered) text += !text || WIDE.test(text.at(-1)!) && WIDE.test(next[0]!) ? next : " " + next;
  return clean(text);
}

/** Projects the main document of a DOMSnapshot into ordered view items. */
export function projectSnapshot(snapshot: Snapshot, viewport: Viewport, options: ViewOptions = {}): NativeView {
  const { strings } = snapshot;
  const doc = snapshot.documents[0];
  const str = (index: number | undefined) => index === undefined || index < 0 ? "" : strings[index] ?? "";
  if (!doc) return { url: "", title: "", header: "(no document)", items: [], omitted: 0 };
  const nodes = doc.nodes;
  const count = nodes.parentIndex?.length ?? 0;
  const parent = nodes.parentIndex ?? [];
  const layoutOf = new Map<number, number>();
  doc.layout.nodeIndex.forEach((node, layout) => { if (!layoutOf.has(node)) layoutOf.set(node, layout); });
  const rare = (data: Rare<unknown> | undefined) => new Set(data?.index ?? []);
  const clickable = rare(nodes.isClickable), checked = rare(nodes.inputChecked), selected = rare(nodes.optionSelected);
  const inputValue = new Map((nodes.inputValue?.index ?? []).map((node, i) => [node, str(nodes.inputValue?.value?.[i])]));
  const tag = (i: number) => str(nodes.nodeName?.[i]).toLowerCase();
  const attrCache = new Map<number, Map<string, string>>();
  const attrs = (i: number) => {
    let map = attrCache.get(i);
    if (!map) {
      map = new Map();
      const list = nodes.attributes?.[i] ?? [];
      for (let k = 0; k + 1 < list.length; k += 2) map.set(str(list[k]).toLowerCase(), str(list[k + 1]));
      attrCache.set(i, map);
    }
    return map;
  };
  const style = (layout: number, name: string) => str(doc.layout.styles[layout]?.[VIEW_STYLES.indexOf(name)]);
  const scale = viewport.scale && viewport.scale > 0 ? viewport.scale : 1;
  const boxOf = (layout: number | undefined) => {
    const bounds = layout === undefined ? undefined : doc.layout.bounds[layout];
    return bounds && bounds.length >= 4 ? { x: bounds[0]! / scale, y: bounds[1]! / scale, w: bounds[2]! / scale, h: bounds[3]! / scale } : null;
  };

  // Hidden or skipped subtrees, resolved once per node in document order (parents first).
  const excluded = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const p = parent[i] ?? -1;
    if (p >= 0 && excluded[p]) { excluded[i] = 1; continue; }
    if (nodes.nodeType?.[i] !== 1) continue;
    const name = tag(i);
    if (SKIP.has(name) || attrs(i).get("aria-hidden") === "true" || (name === "input" && attrs(i).get("type")?.toLowerCase() === "hidden")) { excluded[i] = 1; continue; }
    const layout = layoutOf.get(i);
    if (layout !== undefined && (style(layout, "visibility") === "hidden" || style(layout, "visibility") === "collapse" || style(layout, "opacity") === "0")) excluded[i] = 1;
  }

  const controlKind = (i: number): string | null => {
    if (nodes.nodeType?.[i] !== 1) return null;
    const name = tag(i), a = attrs(i), role = a.get("role")?.toLowerCase() ?? "";
    if (a.has("disabled") && name !== "a") return null;
    if (name === "a" && a.has("href")) return "link";
    if (name === "button" || name === "summary") return "button";
    if (name === "select") return "select";
    if (name === "textarea") return "field";
    if (name === "input") {
      const type = (a.get("type") ?? "").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      return TEXT_INPUTS.has(type) ? "field" : type || "field";
    }
    if (a.get("contenteditable") === "" || a.get("contenteditable") === "true" || a.get("contenteditable") === "plaintext-only") return "field";
    if (ROLES.has(role)) return role === "textbox" || role === "searchbox" ? "field" : role;
    if (clickable.has(i)) return "clickable";
    return null;
  };

  // A text node belongs to the nearest control within a few levels (a link can wrap
  // block elements), otherwise to the nearest block or click-listener element.
  const ownerCache = new Map<number, number>();
  const controlCache = new Map<number, string | null>();
  const kindOf = (i: number) => { if (!controlCache.has(i)) controlCache.set(i, controlKind(i)); return controlCache.get(i) ?? null; };
  const ownerOf = (start: number): number => {
    const cached = ownerCache.get(start);
    if (cached !== undefined) return cached;
    let block = -1, found = -1, depth = 0;
    for (let i = start; i >= 0 && depth < 40; i = parent[i] ?? -1, depth += 1) {
      if (nodes.nodeType?.[i] !== 1) continue;
      const kind = kindOf(i);
      if (kind && kind !== "clickable" && depth <= 6) { found = i; break; }
      if (block < 0) {
        const layout = layoutOf.get(i);
        if (kind === "clickable" || (layout !== undefined && !INLINE.has(style(layout, "display")))) block = i;
      }
      if (block >= 0 && depth >= 6) break;
    }
    const owner = found >= 0 ? found : block;
    ownerCache.set(start, owner);
    return owner;
  };

  type Box = { x: number; y: number; w: number; h: number };
  type Draft = { owner: number; kind: string | null; texts: { text: string; box: Box | null }[]; box: Box | null };
  const fragments = new Map<number, { text: string; box: Box | null }[]>();
  const boxes = doc.textBoxes;
  for (let k = 0; k < (boxes?.layoutIndex.length ?? 0); k += 1) {
    const layout = boxes!.layoutIndex[k]!, bounds = boxes!.bounds[k];
    const piece = clean([...str(doc.layout.text[layout])].slice(boxes!.start[k], boxes!.start[k]! + boxes!.length[k]!).join(""));
    if (!piece || !bounds) continue;
    const list = fragments.get(layout) ?? [];
    list.push({ text: piece, box: { x: bounds[0]! / scale, y: bounds[1]! / scale, w: bounds[2]! / scale, h: bounds[3]! / scale } });
    fragments.set(layout, list);
  }
  const drafts = new Map<number, Draft>();
  const order: Draft[] = [];
  const draftFor = (owner: number) => {
    let draft = drafts.get(owner);
    if (!draft) {
      draft = { owner, kind: kindOf(owner), texts: [], box: boxOf(layoutOf.get(owner)) };
      drafts.set(owner, draft); order.push(draft);
    }
    return draft;
  };
  for (let i = 0; i < count; i += 1) {
    if (excluded[i]) continue;
    const type = nodes.nodeType?.[i];
    if (type === 1 && kindOf(i) && kindOf(i) !== "clickable") {
      const box = boxOf(layoutOf.get(i));
      if (box && box.w > 0 && box.h > 0) draftFor(i);
      continue;
    }
    if (type !== 3) continue;
    const layout = layoutOf.get(i);
    if (layout === undefined) continue;
    const text = clean(str(doc.layout.text[layout]) || str(nodes.nodeValue?.[i]));
    if (!text) continue;
    const owner = ownerOf(parent[i] ?? -1);
    if (owner < 0) continue;
    const draft = draftFor(owner);
    const box = boxOf(layout);
    const lines = fragments.get(layout);
    if (lines?.length) draft.texts.push(...lines);
    else if (draft.texts.at(-1)?.text !== text) draft.texts.push({ text, box });
    if (box && !draft.box) draft.box = box;
  }

  const scrollX = (doc.scrollOffsetX ?? viewport.x * scale) / scale, scrollY = (doc.scrollOffsetY ?? viewport.y * scale) / scale;
  const terms = clean(options.query ?? "").toLowerCase().split(" ").filter(Boolean);
  const inView = (box: Draft["box"]) => !!box && box.w > 0 && box.h > 0 && box.y < scrollY + viewport.height && box.y + box.h > scrollY && box.x < scrollX + viewport.width && box.x + box.w > scrollX;
  const items: ViewItem[] = [];
  for (const draft of order) {
    if (!draft.box || draft.box.w <= 0 || draft.box.h <= 0) continue;
    if (options.scope !== "page" && !inView(draft.box)) continue;
    const ref = nodes.backendNodeId?.[draft.owner];
    const text = joinPieces(draft.texts);
    if (draft.kind && draft.kind !== "clickable" || (draft.kind === "clickable" && text.length <= CONTROL_LABEL)) {
      const a = attrs(draft.owner);
      const label = clip(text || a.get("aria-label") || a.get("title") || a.get("placeholder") || a.get("alt") || a.get("name") || "", CONTROL_LABEL);
      const kind = draft.kind ?? "clickable";
      let extra = "";
      if (kind === "field" || kind === "select") {
        const value = inputValue.get(draft.owner) ?? "";
        if (value && value !== label) extra += ` value=${JSON.stringify(a.get("type") === "password" ? "••••" : clip(clean(value), 60))}`;
        if (!text && a.get("placeholder") && label !== a.get("placeholder")) extra += ` placeholder=${JSON.stringify(clip(a.get("placeholder")!, 40))}`;
      }
      if (checked.has(draft.owner) || selected.has(draft.owner)) extra += " checked";
      const x = Math.round(Math.min(draft.box.x + draft.box.w / 2, draft.box.x + 40) - scrollX), y = Math.round(draft.box.y + draft.box.h / 2 - scrollY);
      const line = `[${ref}] ${kind} ${JSON.stringify(label)}${extra} @${x},${y}`;
      items.push({ key: `#${ref}`, line, ...(ref !== undefined ? { ref } : {}), y: draft.box.y });
    } else if (text) {
      // A targeted (query) read also gives text its point, so a clickable block without a
      // detectable listener can still be clicked; plain reads stay as short as possible.
      const at = terms.length ? ` @${Math.round(Math.min(draft.box.x + draft.box.w / 2, draft.box.x + 40) - scrollX)},${Math.round(draft.box.y + Math.min(draft.box.h, 40) / 2 - scrollY)}` : "";
      items.push({ key: `t:${text.slice(0, 120)}`, line: clip(text, TEXT_LABEL) + at, y: draft.box.y });
    }
  }

  let selectedItems = items, matched: number | undefined;
  if (terms.length) {
    const hits = items.filter(item => terms.some(term => item.line.toLowerCase().includes(term)));
    matched = hits.length;
    if (hits.length) selectedItems = hits;
  }
  const budget = Math.max(400, options.maxChars ?? 3000);
  const kept: ViewItem[] = [];
  let used = 0;
  for (const item of selectedItems) {
    if (used + item.line.length + 1 > budget && kept.length) break;
    kept.push(item); used += item.line.length + 1;
  }
  const url = str(doc.documentURL), title = str(doc.title);
  const height = Math.round(doc.contentHeight ?? 0);
  const header = `${clip(title, 80)} | ${clip(url, 120)} | scroll ${Math.round(scrollY)}/${height} viewport ${Math.round(viewport.width)}x${Math.round(viewport.height)}`;
  return { url, title, header, items: kept, omitted: selectedItems.length - kept.length, ...(matched !== undefined ? { matched } : {}) };
}

/** Renders a full view as text. */
export function renderView(view: NativeView, note = "") {
  const lines = [view.header + note, ...view.items.map(item => item.line)];
  if (view.matched === 0) lines.splice(1, 0, "(no line matched the query; showing the visible page)");
  if (view.omitted) lines.push(`… ${view.omitted} more (scroll, narrow with query, or scope "page")`);
  return lines.join("\n");
}

/**
 * Renders only what changed since the previous view of the same document. Returns
 * null when a full view is the cheaper or the only correct answer: a new page, no
 * previous view, or a change touching most of the view.
 */
export function renderDelta(previous: NativeView | undefined, next: NativeView): string | null {
  if (!previous || previous.url !== next.url) return null;
  const before = new Map(previous.items.map(item => [item.key, item])), after = new Map(next.items.map(item => [item.key, item]));
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const item of next.items) {
    const old = before.get(item.key);
    if (!old) added.push("+ " + item.line);
    else if (old.line !== item.line) changed.push("~ " + item.line);
  }
  for (const item of previous.items) if (!after.has(item.key)) removed.push("- " + clip(item.line, 60));
  const total = added.length + changed.length + removed.length;
  if (!total) return `${next.header}\n(no visible change since the last read)`;
  if (added.length + changed.length > Math.max(6, next.items.length * 0.6)) return null;
  return [`${next.header} | changes +${added.length} ~${changed.length} -${removed.length}`, ...changed, ...added, ...removed.slice(0, 8), ...(removed.length > 8 ? [`- … ${removed.length - 8} more removed`] : [])].join("\n");
}
