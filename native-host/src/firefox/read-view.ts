// Firefox has no DOMSnapshot domain. The read view's snapshot is instead built by a
// function evaluated in a WebDriver BiDi sandbox: an isolated realm that sees the DOM
// through Xray wrappers, so page script cannot observe or tamper with it and none of
// its globals leak into the page. The output has the shape of the parts of
// DOMSnapshot.captureSnapshot that src/browser/native-view.ts reads, in CSS pixels.
//
// The result travels back through native messaging, whose host-to-extension messages
// are capped at 1 MB, so it is kept under a byte budget: everything near the viewport
// (with its ancestors) first, then the rest of the page in document order. The view
// itself is capped at a few thousand characters, so a page read loses nothing it shows.
//
// Refs ([123] in the view) are ids this sandbox assigns to elements. They stay stable
// while an element stays in the document, and are resolved by the DOM.* commands below.

/** The sandbox name; every view command for a document shares this one realm. */
export const VIEW_SANDBOX = "opencode-read-view";

/** Traversal bound and serialized-size budget (bytes, estimated conservatively). */
export const VIEW_LIMITS = { maxNodes: 30000, maxBytes: 600_000 };

/** Builds a DOMSnapshot-shaped JSON string of the main document. Argument: VIEW_LIMITS. */
export const SNAPSHOT_FUNCTION = String.raw`function (limits) {
  const g = globalThis;
  const ids = g.__ocViewIds || (g.__ocViewIds = new WeakMap());
  const live = new Map();
  let nextId = g.__ocViewNext || 1;
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "canvas", "iframe", "object", "embed"]);
  const KEEP = ["role", "aria-hidden", "aria-label", "type", "disabled", "href", "contenteditable", "title", "placeholder", "alt", "name"];
  const ICONISH = new Set(["i", "span", "em", "b"]);
  const root = document.documentElement;
  const sx = window.scrollX, sy = window.scrollY, vw = window.innerWidth, vh = window.innerHeight;
  const size = (text) => /[^\x00-\x7f]/.test(text) ? text.length * 3 : text.length + 8;
  // Collected in document order, parents before children; emitted after pruning.
  const parent = [], type = [], name = [], value = [], attrs = [], id = [], cost = [];
  const styles = [], bounds = [], inView = [], flags = [], formValue = [];
  const range = document.createRange();
  const margin = 200;
  const place = (rect) => {
    const b = [Math.round(rect.left + sx), Math.round(rect.top + sy), Math.round(rect.width), Math.round(rect.height)];
    inView.push(rect.bottom > -margin && rect.top < vh + margin && rect.right > -margin && rect.left < vw + margin);
    return b;
  };
  const stack = root ? [[root, -1, "auto"]] : [];
  while (stack.length && parent.length < limits.maxNodes) {
    const [node, up, upCursor] = stack.pop();
    if (node.nodeType === 3) {
      const text = node.nodeValue || "";
      if (!text.trim()) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (!(rect.width > 0 || rect.height > 0)) continue;
      parent.push(up); type.push(3); name.push("#text"); value.push(text); attrs.push(null); id.push(0); flags.push(0); formValue.push(null);
      styles.push(null); bounds.push(place(rect)); cost.push(40 + size(text));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node.localName || "").toLowerCase();
    if (SKIP.has(tag) || node.getAttribute("aria-hidden") === "true" || (tag === "input" && (node.getAttribute("type") || "").toLowerCase() === "hidden")) continue;
    const style = window.getComputedStyle(node);
    const display = style ? style.display : "";
    if (display === "none" || (style && (style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0"))) continue;
    const list = [];
    let weight = 40 + tag.length;
    for (const key of KEEP) { const text = node.getAttribute(key); if (text !== null) { list.push(key, text); weight += key.length + size(text); } }
    if (ICONISH.has(tag)) { const text = node.getAttribute("class"); if (text) { list.push("class", text); weight += size(text); } }
    let nodeId = ids.get(node);
    if (!nodeId) { nodeId = nextId++; ids.set(node, nodeId); }
    live.set(nodeId, new WeakRef(node));
    // flags: 1 checked, 2 selected, 4 clickable. formValue: [kind, text] (input or textarea value).
    let flag = 0, form = null;
    if (tag === "input") {
      const kind = (node.getAttribute("type") || "").toLowerCase();
      if (kind === "checkbox" || kind === "radio") { if (node.checked) flag |= 1; }
      else if (node.value) form = ["input", node.value];
    } else if (tag === "textarea") { if (node.value) form = ["textarea", node.value]; }
    else if (tag === "select") { const option = node.selectedOptions && node.selectedOptions[0]; if (option && option.text) form = ["input", option.text]; }
    else if (tag === "option" && node.selected) flag |= 2;
    // No listener list is visible from here, so a pointer cursor that starts at this
    // element (or an inline handler) stands in for Chromium's click-listener flag.
    const cursor = style ? style.cursor : "auto";
    if (node.hasAttribute("onclick") || (cursor === "pointer" && upCursor !== "pointer")) flag |= 4;
    if (form) weight += size(form[1]);
    let box = null;
    if (display !== "contents") {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0 || node.getClientRects().length) box = rect;
    }
    const index = parent.length;
    parent.push(up); type.push(1); name.push(node.nodeName); value.push(null); attrs.push(list); id.push(nodeId); flags.push(flag); formValue.push(form);
    if (box) { styles.push([display, style ? style.visibility : "", style ? style.opacity : ""]); bounds.push(place(box)); weight += 40; }
    else { styles.push(null); bounds.push(null); inView.push(false); }
    cost.push(weight);
    const children = [];
    if (node.shadowRoot) for (let child = node.shadowRoot.firstChild; child; child = child.nextSibling) children.push(child);
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    for (let k = children.length - 1; k >= 0; k -= 1) stack.push([children[k], index, cursor]);
  }
  g.__ocViewNext = nextId;
  g.__ocViewNodes = live;

  const count = parent.length, keep = new Uint8Array(count);
  let used = 0;
  const mark = (i) => { for (; i >= 0 && !keep[i]; i = parent[i]) { keep[i] = 1; used += cost[i]; } };
  for (let i = 0; i < count; i += 1) if (inView[i]) mark(i);
  for (let i = 0; i < count && used < limits.maxBytes; i += 1) mark(i);

  const strings = [], interned = new Map();
  const s = (text) => { let i = interned.get(text); if (i === undefined) { i = strings.length; strings.push(text); interned.set(text, i); } return i; };
  const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], backendNodeId: [], attributes: [], inputValue: { index: [], value: [] }, textValue: { index: [], value: [] }, inputChecked: { index: [] }, optionSelected: { index: [] }, isClickable: { index: [] } };
  const layout = { nodeIndex: [], styles: [], bounds: [], text: [] };
  const renumbered = new Int32Array(count);
  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    if (!keep[i]) continue;
    const k = kept++;
    renumbered[i] = k;
    nodes.parentIndex.push(parent[i] >= 0 ? renumbered[parent[i]] : -1);
    nodes.nodeType.push(type[i]); nodes.nodeName.push(s(name[i])); nodes.nodeValue.push(value[i] === null ? -1 : s(value[i])); nodes.backendNodeId.push(id[i]);
    nodes.attributes.push(attrs[i] ? attrs[i].map(s) : []);
    if (flags[i] & 1) nodes.inputChecked.index.push(k);
    if (flags[i] & 2) nodes.optionSelected.index.push(k);
    if (flags[i] & 4) nodes.isClickable.index.push(k);
    if (formValue[i]) { const target = formValue[i][0] === "textarea" ? nodes.textValue : nodes.inputValue; target.index.push(k); target.value.push(s(formValue[i][1])); }
    if (bounds[i]) { layout.nodeIndex.push(k); layout.styles.push(styles[i] ? styles[i].map(s) : []); layout.bounds.push(bounds[i]); layout.text.push(type[i] === 3 ? s(value[i]) : -1); }
  }
  const width = Math.max(vw, root ? root.scrollWidth : 0), height = Math.max(vh, root ? root.scrollHeight : 0);
  return JSON.stringify({
    documents: [{ documentURL: s(location.href), title: s(document.title), scrollOffsetX: sx, scrollOffsetY: sy, contentWidth: width, contentHeight: height, nodes, layout }],
    strings,
    truncated: kept < count || !!stack.length,
  });
}`;

/** Page.getLayoutMetrics-shaped JSON string, read from the sandbox rather than the page realm. */
export const LAYOUT_METRICS_FUNCTION = String.raw`function () {
  const root = document.documentElement, visual = window.visualViewport;
  const size = { x: 0, y: 0, width: Math.max(window.innerWidth, root ? root.scrollWidth : 0), height: Math.max(window.innerHeight, root ? root.scrollHeight : 0) };
  const clientWidth = root ? root.clientWidth : window.innerWidth, clientHeight = root ? root.clientHeight : window.innerHeight;
  return JSON.stringify({
    contentSize: size, cssContentSize: size,
    cssLayoutViewport: { pageX: window.scrollX, pageY: window.scrollY, clientWidth, clientHeight },
    cssVisualViewport: visual
      ? { offsetX: visual.offsetLeft, offsetY: visual.offsetTop, pageX: visual.pageLeft, pageY: visual.pageTop, clientWidth: visual.width, clientHeight: visual.height, scale: visual.scale, zoom: 1 }
      : { offsetX: 0, offsetY: 0, pageX: window.scrollX, pageY: window.scrollY, clientWidth, clientHeight, scale: 1, zoom: 1 },
  });
}`;

// Resolves a ref to its live element, or returns early once it left the document.
const LOOKUP = `const nodes = globalThis.__ocViewNodes; const ref = nodes && nodes.get(id); const node = ref && ref.deref(); if (!node || !node.isConnected) return`;

/** Scrolls a ref into view when it is outside the viewport, like DOM.scrollIntoViewIfNeeded. */
export const SCROLL_REF_FUNCTION = `function (id) { ${LOOKUP} false;
  const rect = node.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) node.scrollIntoView({ block: "center", inline: "nearest" });
  return true; }`;

/** A ref's border boxes as viewport quads, like DOM.getContentQuads. */
export const REF_QUADS_FUNCTION = `function (id) { ${LOOKUP} "[]";
  return JSON.stringify(Array.from(node.getClientRects(), r => [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom])); }`;
