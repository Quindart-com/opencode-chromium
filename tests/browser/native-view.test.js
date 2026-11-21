import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ArtifactStore } from "../../src/core/artifacts.ts";
import { AgentBrowserRuntime } from "../../src/core/runtime.ts";
import { layoutScale, projectSnapshot, renderDelta, renderView } from "../../src/browser/native-view.ts";

// Builds a DOMSnapshot-shaped document from a small tree. Elements: [tag, attrs, box, children, extra];
// text: string, or { text, box, lines: [[text, box], ...] } for line fragments.
function snapshot(tree, { scale = 1, scrollY = 0, contentHeight = 2000, url = "https://site.test/page", title = "Page" } = {}) {
  const strings = [];
  const s = value => { const at = strings.indexOf(value); if (at >= 0) return at; strings.push(value); return strings.length - 1; };
  const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], backendNodeId: [], attributes: [], isClickable: { index: [] }, inputValue: { index: [], value: [] } };
  const layout = { nodeIndex: [], styles: [], bounds: [], text: [] };
  const textBoxes = { layoutIndex: [], bounds: [], start: [], length: [] };
  const scaled = box => box.map(value => value * scale);
  const add = (node, parent) => {
    const index = nodes.parentIndex.length;
    nodes.parentIndex.push(parent);
    nodes.backendNodeId.push(100 + index);
    if (typeof node === "string" || node.text !== undefined) {
      const text = typeof node === "string" ? node : node.text;
      nodes.nodeType.push(3); nodes.nodeName.push(s("#text")); nodes.nodeValue.push(s(text)); nodes.attributes.push([]);
      const box = typeof node === "string" ? [0, 0, 10, 10] : node.box;
      layout.nodeIndex.push(index); layout.styles.push([s("inline"), s("visible"), s("1")]); layout.bounds.push(scaled(box)); layout.text.push(s(text));
      let offset = 0;
      for (const [line, lineBox] of node.lines ?? []) {
        textBoxes.layoutIndex.push(layout.nodeIndex.length - 1); textBoxes.bounds.push(scaled(lineBox));
        textBoxes.start.push(offset); textBoxes.length.push([...line].length); offset += [...line].length;
      }
      return;
    }
    const [tag, attrs = {}, box = null, children = [], extra = {}] = node;
    nodes.nodeType.push(1); nodes.nodeName.push(s(tag.toUpperCase())); nodes.nodeValue.push(-1);
    nodes.attributes.push(Object.entries(attrs).flatMap(([k, v]) => [s(k), s(v)]));
    if (extra.clickable) nodes.isClickable.index.push(index);
    if (extra.value !== undefined) { nodes.inputValue.index.push(index); nodes.inputValue.value.push(s(extra.value)); }
    if (box) { layout.nodeIndex.push(index); layout.styles.push([s(extra.display ?? "block"), s(extra.visibility ?? "visible"), s(extra.opacity ?? "1")]); layout.bounds.push(scaled(box)); layout.text.push(-1); }
    for (const child of children) add(child, index);
  };
  add(["html", {}, [0, 0, 1000, contentHeight], [tree]], -1);
  return { strings: [...strings, url, title].map(String), documents: [{ documentURL: s(url), title: s(title), scrollOffsetX: 0, scrollOffsetY: scrollY * scale, contentWidth: 1000 * scale, contentHeight: contentHeight * scale, nodes, layout, textBoxes }] };
}
const viewport = { x: 0, y: 0, width: 1000, height: 800 };

test("the view lists controls with click points and visible text, skipping hidden and scripted content", () => {
  const snap = snapshot(["body", {}, [0, 0, 1000, 2000], [
    ["a", { href: "/jobs/1" }, [100, 100, 200, 20], [{ text: "Frontend engineer", box: [100, 100, 200, 20] }], { display: "inline" }],
    ["div", {}, [100, 140, 600, 40], ["Build and ship the web app."]],
    ["input", { type: "text", placeholder: "Search jobs" }, [100, 200, 300, 30], [], { value: "react" }],
    ["input", { type: "password" }, [100, 240, 300, 30], [], { value: "hunter2" }],
    ["div", {}, [100, 280, 600, 40], ["Secret hidden"], { visibility: "hidden" }],
    ["script", {}, null, ["window.secret = 1"]],
    ["div", { "aria-hidden": "true" }, [100, 320, 600, 40], ["decorative"]],
    ["div", {}, [100, 900, 600, 40], ["below the fold"]],
  ]]);
  const view = projectSnapshot(snap, viewport);
  const text = renderView(view);
  assert.match(text, /^Page \| https:\/\/site\.test\/page \| scroll 0\/2000 viewport 1000x800/);
  assert.match(text, /\[\d+\] link "Frontend engineer" @140,110/);
  assert.match(text, /Build and ship the web app\./);
  assert.match(text, /field "Search jobs" value="react"/);
  assert.match(text, /value="••••"/, "password values are masked");
  assert.doesNotMatch(text, /hunter2|Secret hidden|window\.secret|decorative|below the fold/);
  assert.match(renderView(projectSnapshot(snap, viewport, { scope: "page" })), /below the fold/);
});

test("device-pixel layouts are converted back to CSS pixels", () => {
  const snap = snapshot(["body", {}, [0, 0, 1000, 2000], [["button", {}, [400, 300, 100, 40], ["Apply"]]]], { scale: 1.5, scrollY: 100 });
  const scale = layoutScale(snap.documents[0], { width: 1000, height: 2000 });
  assert.equal(scale, 1.5);
  assert.match(renderView(projectSnapshot(snap, { ...viewport, scale })), /button "Apply" @440,220/);
  assert.equal(layoutScale({ contentWidth: 1000, contentHeight: 2000 }, { width: 1000, height: 2000 }), 1);
});

test("text is read in on-screen line order, and CJK pieces join without spaces", () => {
  // DOM order is shuffled; the line fragments carry the true positions.
  const snap = snapshot(["body", {}, [0, 0, 1000, 2000], [["p", {}, [0, 0, 800, 60], [
    { text: "第二行内容", box: [0, 30, 300, 20], lines: [["第二行内容", [0, 30, 300, 20]]] },
    { text: "第一行开头第一行结尾", box: [0, 0, 600, 20], lines: [["第一行开头", [0, 0, 300, 20]], ["第一行结尾", [300, 0, 300, 20]]] },
  ]]]]);
  assert.match(renderView(projectSnapshot(snap, viewport)), /第一行开头第一行结尾第二行内容/);
});

test("a query narrows the view, and the character budget is reported", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ["div", {}, [0, i * 12, 800, 12], [`Row ${i} lorem ipsum dolor sit amet`]]);
  const snap = snapshot(["body", {}, [0, 0, 1000, 2000], [...rows, ["div", {}, [0, 740, 800, 20], ["Salary range 15-16k"]]]]);
  const narrowed = projectSnapshot(snap, viewport, { query: "salary" });
  assert.equal(narrowed.items.length, 1);
  assert.match(renderView(narrowed), /^Salary range 15-16k @40,750$/m, "a targeted read gives text a click point");
  assert.doesNotMatch(renderView(projectSnapshot(snap, viewport)), /Salary range 15-16k @/, "plain reads stay short");
  const budget = projectSnapshot(snap, viewport, { maxChars: 400 });
  assert.ok(budget.omitted > 0);
  assert.match(renderView(budget), /… \d+ more \(scroll, narrow with query, or scope "page"\)/);
  assert.match(renderView(projectSnapshot(snap, viewport, { query: "nothing-matches" })), /no line matched the query/);
});

test("repeat reads return only what changed, and a new page returns a full view", () => {
  const page = detail => snapshot(["body", {}, [0, 0, 1000, 2000], [
    ["a", { href: "/a" }, [0, 0, 100, 20], ["Job A"], { display: "inline" }],
    ["a", { href: "/b" }, [0, 30, 100, 20], ["Job B"], { display: "inline" }],
    ["div", {}, [300, 0, 600, 40], [detail]],
  ]]);
  const first = projectSnapshot(page("Description of job A"), viewport);
  assert.equal(renderDelta(undefined, first), null);
  assert.match(renderDelta(first, projectSnapshot(page("Description of job A"), viewport)), /no visible change since the last read/);
  const delta = renderDelta(first, projectSnapshot(page("Description of job B"), viewport));
  assert.match(delta, /changes \+1 ~0 -1/);
  assert.match(delta, /^\+ Description of job B$/m);
  assert.match(delta, /^- Description of job A$/m);
  assert.doesNotMatch(delta, /Job A"/, "unchanged lines are not repeated");
  const moved = snapshot(["body", {}, [0, 0, 1000, 2000], [["a", { href: "/a" }, [0, 0, 100, 20], ["Job A"]]]], { url: "https://site.test/other" });
  assert.equal(renderDelta(first, projectSnapshot(moved, viewport)), null);
});

function runtimeWithView({ guarded = false } = {}) {
  const calls = [];
  const runtime = new AgentBrowserRuntime({
    artifactStore: new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "native-view-test-")) }),
    hostRequest: async method => method === "semantic.status" ? { settings: {} } : method === "memory.captureState" ? { enabled: false } : {},
  });
  runtime.selectProfile = async session => { session.profileId = "p"; if (guarded) session.guardedHosts.add("guarded.test"); return { profileId: "p" }; };
  runtime.ensureTab = async session => { session.activeTabId = 7; return 7; };
  runtime.executeStep = async () => ({ clicked: true });
  runtime.settleStep = async () => ({ condition: "dom-quiet", settled: true });
  runtime.invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === "browser_list_tabs") return { tabs: [{ id: 7, url: "https://guarded.test/jobs" }] };
    if (name === "browser_read_view") return { url: "https://guarded.test/jobs", title: "Jobs", view: "Jobs | changes +1 ~0 -0\n+ Description", delta: true };
    if (name === "browser_selected_tab") return { id: 7 };
    return { results: [] };
  };
  return { runtime, calls };
}

test("observe mode read uses the script-free view and never the page-script search", async () => {
  const { runtime, calls } = runtimeWithView();
  try {
    const result = await runtime.observe({ sessionId: "read", mode: "read", query: "salary" });
    assert.equal(result.ok, true);
    assert.equal(result.result.view.startsWith("Jobs"), true);
    const [name, args] = calls.find(([call]) => call === "browser_read_view");
    assert.equal(name, "browser_read_view");
    assert.deepEqual(args, { tabId: 7, query: "salary", scope: "viewport", maxChars: 3000, delta: true });
    assert.equal(calls.some(([call]) => call === "browser_page_search"), false);
  } finally { runtime.close(); }
});

test("a guarded host reads with the view, and actions there return the change summary", async () => {
  const { runtime, calls } = runtimeWithView({ guarded: true });
  try {
    await runtime.observe({ sessionId: "guarded", mode: "search", query: "apply" });
    assert.equal(calls.some(([call]) => call === "browser_page_search"), false);
    assert.equal(calls.filter(([call]) => call === "browser_read_view").length, 1);
    const run = await runtime.run({ sessionId: "guarded", memoryMode: "off", steps: [{ action: "click", target: { x: 10, y: 10 } }] });
    assert.equal(run.ok, true);
    assert.match(run.observation.view, /changes \+1/);
  } finally { runtime.close(); }
});

test("ordinary hosts pay nothing extra after an action", async () => {
  const { runtime, calls } = runtimeWithView();
  try {
    const run = await runtime.run({ sessionId: "plain", memoryMode: "off", steps: [{ action: "click", target: { x: 10, y: 10 } }] });
    assert.equal(run.observation, undefined);
    assert.equal(calls.some(([call]) => call === "browser_read_view"), false);
  } finally { runtime.close(); }
});
