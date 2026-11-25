import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";
import { shapePageSearchRanking } from "../src/browser/operations/index.ts";
import { createInspectionOperations } from "../src/browser/operations/operation-groups/inspection.ts";
import { pageStateExpression } from "../src/browser/operations/page-state.ts";
import { createOperationSessionRuntime } from "../src/browser/operations/session-runtime.ts";
import { McpWorker } from "../src/control/mcp-worker.ts";
import { harnessControls } from "../src/control/harness-control.ts";

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/changing-form") {
    res.end(`<!doctype html><title>Changing confirmation</title>
      <form data-submissions="0"><button id="record-entry">Record entry</button></form>
      <p id="confirmation" role="status">Pending</p>
      <script>
        const form = document.querySelector("form");
        let revision = 0;
        window.rerenderConfirmation = () => {
          document.querySelector("#confirmation").outerHTML = '<p id="confirmation" role="status">Saved submissions: ' +
            form.dataset.submissions + ', revision ' + ++revision + '</p>';
        };
        form.addEventListener("submit", event => {
          event.preventDefault();
          form.dataset.submissions = Number(form.dataset.submissions) + 1;
          window.rerenderConfirmation();
        });
      </script>`);
    return;
  }
  if (req.url.startsWith("/frame")) {
    res.end(`<title>Embedded picker</title><style>body{margin:8px}button{height:40px}</style><button id="choose" onclick="document.querySelector('#status').textContent='Chosen'">Choose photo</button><input id="asset" type="file" onchange="this.files[0].text().then(text=>document.querySelector('#preview').textContent=text)"><button id="frame-prompt" onclick="prompt('Embedded fixture prompt')">Embedded prompt</button><p id="preview">No asset</p><p id="status">Ready</p>${req.url.includes("nested") ? "" : '<iframe src="/frame?nested" style="width:350px;height:180px"></iframe>'}`);
    return;
  }
  res.end(`<!doctype html><title>Reliability fixture</title><style>button{height:40px}iframe{width:470px;height:280px}#shadow{display:inline-block}</style>
    <button id="alpha"><span>Alpha</span></button><button id="beta">Beta</button><p id="chosen">None</p>
    <a id="edit" href="#edit" onclick="document.querySelector('#chosen').textContent='Link activated'">Edit setting</a>
    <input id="readonly" readonly value="Read only"><select id="choice"><option>Blue</option></select><div id="editable" contenteditable>Editable text</div><div tabindex="0" id="custom">Custom focus</div>
    <input id="display-name" aria-label="Display name" value="Original name"><input id="other-name" aria-label="Other name" value="Other name"><button id="save-name">Save display name</button>
    <div id="shadow"></div><button id="open" onclick="setTimeout(()=>editor.showModal(),350)">Open editor</button>
    <dialog id="editor"><h2>Edit setting</h2><button id="photo">Insert Photo</button><button onclick="editor.close()">Done</button></dialog>
    <button id="prompt" onclick="window.prompt('Fixture image URL')">Prompt fixture</button>
    <iframe id="same" src="/frame?same"></iframe><iframe id="cross" src="http://localhost:${server.address().port}/frame?cross"></iframe>
    <script>alpha.onclick=()=>chosen.textContent='Alpha';beta.onclick=()=>chosen.textContent='Beta';shadow.attachShadow({mode:'open'}).innerHTML='<button>Shadow control</button>';</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let fixture, agent, mcp;
const checks = [];
const checked = name => { checks.push(name); console.log("Verified:", name); };
try {
  process.env.OPENCODE_BROWSER_MEMORY_EMBED = "0";
  fixture = await chromiumExtensionFixture();
  const { createBrowserAgent } = await import("../src/adapters/sdk/index.ts");
  agent = createBrowserAgent();
  const sessionId = "reliability-fixture", profile = fixture.profileId;
  const raw = (name, args) => agent.call(name, { profile, sessionId, ...args });
  const call = async (name, args) => { const result = await raw(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const run = async (steps, options = {}) => {
    let result = await raw("browser_run", { memoryMode: "off", returnMode: "all", maxChars: 20000, steps, ...options });
    if (result.status === "approval_required") result = await agent.call("browser_run", { sessionId, approvalToken: result.approvalToken });
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  const mainTab = await call("browser_session", { action: "new-tab" });
  const mainTabId = mainTab.activeTabId;
  const origin = `http://127.0.0.1:${server.address().port}`;
  await run([{ action: "navigate", url: origin + "/changing-form" }]);
  const changingPage = fixture.context.pages().find(page => page.url() === origin + "/changing-form");
  assert.ok(changingPage);
  const tools = await agent.runtime.legacyToolsPromise;
  const original = {
    browser_locator_click: tools.browser_locator_click,
    browser_locator_text: tools.browser_locator_text,
    browser_page_search: tools.browser_page_search,
  };
  const searchRuntime = createOperationSessionRuntime();
  const pageState = pageStateExpression();
  let freshnessChecks = 0;
  const { browser_page_search: searchWithRerender } = createInspectionOperations({
    ...searchRuntime,
    shapePageSearchRanking,
    async runtimeEvaluate(context, tabId, expression, options) {
      // Invalidate the two captures in the first search after ranking, before
      // its freshness check. The next search can return the stable document.
      if (expression === pageState && ++freshnessChecks <= 2) {
        await changingPage.evaluate(() => window.rerenderConfirmation());
      }
      return searchRuntime.runtimeEvaluate(context, tabId, expression, options);
    },
  });
  const durations = { action: [], settle: [], postObserve: [] };
  const timed = (operation, phase) => ({
    ...operation,
    async execute(args, context) {
      const start = performance.now();
      try { return await operation.execute(args, context); }
      finally { durations[phase].push(Math.round(performance.now() - start)); }
    },
  });
  tools.browser_locator_click = timed(original.browser_locator_click, "action");
  tools.browser_locator_text = timed(original.browser_locator_text, "settle");
  tools.browser_page_search = timed(searchWithRerender, "postObserve");
  const entrySteps = [{ action: "click", target: { selector: "#record-entry" },
    settle: { condition: "contains", target: { selector: "#confirmation" }, value: "Saved" } }];
  const submissions = () => changingPage.locator("form").getAttribute("data-submissions");
  const verifyConfirmation = async (memoryMode, status) => {
    freshnessChecks = 0;
    for (const phase of Object.values(durations)) phase.length = 0;
    const result = await raw("browser_run", { memoryMode, steps: entrySteps,
      postObserve: { mode: "search", searchStrategy: "lexical", query: "Saved submissions", limit: 1 },
    });
    assert.equal(await submissions(), "1");
    console.log(`Changing-form ${memoryMode} operation durations (ms)`, durations);
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.results[0].ok, true);
    if (status === "memory_replay") assert.deepEqual(result.memory, { used: true, stepsReused: 1, fallback: false });
    else assert.equal(result.results[0].result.clicked, true);
    assert.equal(result.results[0].settle.settled, true);
    assert.equal(result.observation.results[0].label, "Saved submissions: 1, revision 3");
    assert.equal(durations.postObserve.length, 2);
    assert.equal(freshnessChecks, 3);
  };
  try {
    await verifyConfirmation("off", "completed");
    const session = agent.runtime.getSession(sessionId);
    assert.equal((await agent.runtime.requestHost("memory.enable", {}, session)).enabled, true);
    try {
      await run([{ action: "reload" }]);
      assert.equal((await run(entrySteps, { memoryMode: "auto" })).status, "completed");
      assert.equal(await submissions(), "1");
      await run([{ action: "reload" }]);
      await verifyConfirmation("auto", "memory_replay");
    } finally {
      await agent.runtime.requestHost("memory.disable", {}, session);
    }
  } finally {
    Object.assign(tools, original);
  }
  checked("stale post-action ranking recovers a fresh confirmation with one form submission in both memory modes");
  await run([{ action: "navigate", url: origin }]);
  const page = fixture.context.pages().find(page => page.url().startsWith(origin));
  assert.ok(page);
  page.on("dialog", () => {});
  const waitDialog = async type => {
    for (let i = 0; i < 40; i++) {
      const events = await call("browser_observe", { mode: "events", limit: 5, maxChars: 20000 });
      if (events.result.dialogs.open?.type === type) return events.result.dialogs.open;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Native " + type + " dialog was not observed");
  };
  const waitReadable = async () => {
    let observed;
    for (let i = 0; i < 100; i++) {
      observed = await raw("browser_observe", { mode: "inspect", target: { selector: "#beta" } });
      if (observed.ok) return;
      assert.equal(observed.error?.code, "TAB_UNHEALTHY", JSON.stringify(observed));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("Tab did not become readable after dialog recovery: " + JSON.stringify(observed));
  };
  checked("real extension, native host, and shared runtime");

  const search = await call("browser_observe", { mode: "search", query: "Alpha", searchStrategy: "lexical", detail: "compact" });
  const alpha = search.result.results.find(node => node.selector === "#alpha"); assert.ok(alpha);
  await call("browser_observe", { mode: "visual", target: { selector: "#beta" } });
  await call("browser_observe", { mode: "inspect", target: { selector: "#beta" } });
  await run([{ action: "click", target: { nodeId: alpha.node_id } }]);
  assert.equal(await page.locator("#chosen").innerText(), "Alpha");
  const captured = (await call("browser_observe", { mode: "visual", target: { selector: "#alpha" } })).result.observation;
  assert.ok(captured.documentId && captured.capturedAt && captured.frameId);
  checked("stable target identity across search, visual mapping, inspection, and action");

  await run([{ action: "click", target: { selector: "#alpha span" } }]);
  await page.evaluate(() => { const target = document.querySelector('#alpha span'), rect = target.getBoundingClientRect(), overlay = target.cloneNode(true); overlay.id = 'fixture-overlay'; Object.assign(overlay.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'99999'}); document.body.append(overlay); });
  const obstructed = await raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { selector: "#alpha span" } }] });
  assert.equal(obstructed.results[0].error.code, "TARGET_OBSTRUCTED");
  assert.notEqual(obstructed.results[0].error.details.target, obstructed.results[0].error.details.hit);
  assert.ok(obstructed.results[0].error.details.samples.length <= 7);
  await page.evaluate(() => document.querySelector('#fixture-overlay').remove());
  // Agent helpers run in an isolated world the page cannot write to, so the
  // fixture can no longer seed the node map. A point inside the shadow root
  // exercises the same shadow-piercing hit testing.
  await page.evaluate(() => { const button = document.querySelector('#shadow').shadowRoot.querySelector('button'); button.onclick = () => { chosen.textContent = 'Shadow'; }; });
  const shadowPoint = await page.evaluate(() => { const rect = document.querySelector('#shadow').shadowRoot.querySelector('button').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; });
  await run([{ action: "click", target: shadowPoint }]);
  assert.equal(await page.locator("#chosen").innerText(), "Shadow");
  checked("self/descendant hits, lookalike overlay diagnostics, and shadow-root hit testing");

  const { view } = (await call("browser_observe", { mode: "read", detail: "full", query: "display name" })).result;
  const nameField = view.match(/^\[(\d+)\] field "Display name" /m);
  const saveName = view.match(/^\[(\d+)\] button "Save display name" /m);
  assert.ok(nameField && saveName, view);
  await page.evaluate(() => {
    const name = document.querySelector("#display-name");
    const other = document.querySelector("#other-name");
    window.preferenceJournal = [];
    for (const field of [name, other]) {
      field.addEventListener("input", () => window.preferenceJournal.push(["draft", field.id, field.value]));
    }
    document.querySelector("#save-name").addEventListener("click", () => window.preferenceJournal.push(["save", name.value]));
    other.focus();
  });
  const displayName = "Équipe Rivière";
  const fillName = { action: "fill", target: { ref: Number(nameField[1]) }, value: displayName };
  const renamed = await run([
    fillName,
    { action: "click", target: { ref: Number(saveName[1]) } },
  ], { inputMode: "dom" });
  assert.equal(renamed.results[0].result.inputRoute, "dom");
  const expectedJournal = [["draft", "display-name", displayName], ["save", displayName]];
  assert.deepEqual(await page.evaluate(() => window.preferenceJournal), expectedJournal);
  await page.locator("#display-name").evaluate(field => {
    field.addEventListener("click", () => document.querySelector("#other-name").focus(), { once: true });
  });
  const redirected = await raw("browser_run", { memoryMode: "off", inputMode: "dom", steps: [{ ...fillName, value: "Second name" }] });
  assert.equal(redirected.results[0].error?.code, "TARGET_NOT_FOCUSABLE", JSON.stringify(redirected));
  assert.deepEqual(await page.evaluate(() => window.preferenceJournal), expectedJournal);
  checked("background fill by read ref commits the intended value and stops on redirected focus");

  for (const selector of ["#edit", "#readonly", "#choice", "#editable", "#custom", "#beta"]) {
    await run([{ action: "focus", target: { selector } }]);
    assert.equal(await page.evaluate(() => document.activeElement.id), selector.slice(1));
  }
  await run([{ action: "press", target: { selector: "#edit" }, key: "Enter" }]);
  assert.equal(await page.locator("#chosen").innerText(), "Link activated");
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await run([{ action: "press", key: "Control+A" }]);
  assert.ok(await page.evaluate(() => window.getSelection().toString().length > 0));
  checked("focusable controls, targeted Enter, and static-page select-all");

  await run([{ action: "click", target: { selector: "#open" }, settle: { condition: "exists", target: { selector: "dialog[open]" } } }]);
  const inspection = await call("browser_observe", { mode: "inspect" });
  assert.equal(inspection.result.target.selector, "#editor");
  await page.locator("dialog button").last().click();
  checked("delayed dialogs and dialog-first inspection");

  const discovered = await run([{ action: "capability", capability: "frames.list", input: { maxDepth: 8, maxFrames: 50 } }]);
  const frames = discovered.results[0].result.frames;
  assert.ok(frames.length >= 5, JSON.stringify(frames));
  for (const frame of frames.filter(frame => frame.depth === 1)) {
    const frameId = frame.frameId;
    const observation = await call("browser_observe", { mode: "search", target: { frameId }, query: "Choose photo", searchStrategy: "lexical", detail: "compact" });
    assert.equal(observation.result.observation.frameId, frameId);
    const target = observation.result.results.find(node => node.selector === "#choose"); assert.ok(target);
    assert.equal(target.frameId, frameId);
    await run([{ action: "click", target: { frameId, nodeId: target.node_id } }]);
    const status = await call("browser_observe", { mode: "extract", target: { frameId, selector: "#status" } });
    assert.match(JSON.stringify(status), /Chosen/);
    const prompting = raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { frameId, selector: "#frame-prompt" }, timeoutMs: 1500 }] });
    await waitDialog("prompt");
    await run([{ action: "handleDialog", target: { frameId }, value: "dismiss" }]);
    await prompting;
    await waitReadable();
    const file = path.join(fixture.fixture, "approved.txt"); fs.writeFileSync(file, "Processed embedded asset");
    let completed;
    const pending = run([{ action: "upload", target: { frameId, selector: "#asset" }, files: [file], settle: { condition: "contains", target: { frameId, selector: "#preview" }, value: "Processed embedded asset" } }], { postObserve: { mode: "extract", target: { frameId, selector: "#preview" } } }).then(result => completed = { result }, error => completed = { error });
    let confirmation;
    for (let i = 0; i < 100; i++) { confirmation = fixture.context.pages().find(page => page.url().includes("upload-confirm.html")); if (confirmation) break; if (completed?.error) throw completed.error; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(confirmation, "real upload confirmation is visible");
    await confirmation.getByRole("button", { name: "Allow upload", exact: true }).click().catch(error => { if (!confirmation.isClosed()) throw error; });
    await pending;
    if (completed?.error) throw completed.error;
    const preview = await call("browser_observe", { mode: "extract", target: { frameId, selector: "#preview" } });
    assert.match(JSON.stringify(preview), /Processed embedded asset/);
  }
  checked("same-origin and out-of-process cross-origin frame search, clicks, and approved uploads");

  for (const frame of frames.filter(frame => frame.depth === 2)) {
    await run([{ action: "click", target: { frameId: frame.frameId, selector: "#choose" }, settle: { condition: "contains", target: { frameId: frame.frameId, selector: "#status" }, value: "Chosen" } }]);
  }
  const embedded = await page.locator('#same').boundingBox();
  const unresolved = await raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { x: embedded.x + 10, y: embedded.y + 10 } }] });
  assert.equal(unresolved.results[0].error.code, "FRAME_TARGET_REQUIRED");
  await page.evaluate(() => { const cover = document.createElement('div'); cover.id='frame-cover'; Object.assign(cover.style,{position:'fixed',inset:'0',zIndex:'99999',background:'white'}); document.body.append(cover); });
  const coveredFrame = await raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { frameId: frames.find(frame => frame.depth === 1).frameId, selector: "#choose" } }] });
  assert.equal(coveredFrame.results[0].error.code, "FRAME_OBSTRUCTED");
  await page.evaluate(() => document.querySelector('#frame-cover').remove());
  await page.locator('#same').evaluate(element => element.style.transform = 'rotate(10deg)');
  const transformed = await raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { frameId: frames.find(frame => frame.depth === 1).frameId, selector: "#choose" } }] });
  assert.equal(transformed.results[0].error.code, "UNSUPPORTED_FRAME");
  await page.locator('#same').evaluate(element => element.style.transform = '');
  checked("nested frame geometry, unresolved iframe coordinates, and real ancestor overlays");

  const safeTab = await call("browser_session", { action: "new-tab" });
  await page.bringToFront();
  const promptCall = raw("browser_run", { tab: { tabId: mainTabId }, memoryMode: "off", steps: [{ action: "click", target: { selector: "#prompt" }, timeoutMs: 1500 }] });
  let nativeDialog;
  for (let i = 0; i < 40; i++) {
    const events = await call("browser_observe", { mode: "events", limit: 5, maxChars: 20000 });
    if (events.result.dialogs.open) { nativeDialog = events.result.dialogs.open; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(nativeDialog?.type, "prompt", nativeDialog ? JSON.stringify(nativeDialog) : JSON.stringify(await promptCall));
  const partial = await raw("browser_finalize", { keep: [mainTabId] });
  assert.equal(partial.status, "partial");
  assert.ok(partial.result.profiles[profile].tabs.some(tab => tab.tabId === safeTab.activeTabId && tab.status === "released"));
  await run([{ action: "handleDialog", value: "dismiss" }]);
  await promptCall;
  await waitReadable();
  await run([{ action: "click", target: { selector: "#beta" } }]);
  assert.equal(await page.locator("#chosen").innerText(), "Beta");
  checked("native dialog discovery, partial finalization, and recovery while activation is pending");

  await run([{ action: "reload" }]);
  const stale = await raw("browser_run", { memoryMode: "off", steps: [{ action: "click", target: { nodeId: alpha.node_id } }] });
  assert.equal(stale.ok, false);
  assert.equal(stale.results[0].error.code, "STALE_TARGET");
  checked("expired document handles fail before mutation");
  const beforeUnloadUrl = page.url();
  await page.evaluate(() => { window.onbeforeunload = () => true; });
  await page.locator('#beta').click();
  const navigating = raw("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url: origin + "/next", timeoutMs: 1500 }] });
  await waitDialog("beforeunload");
  await run([{ action: "handleDialog", value: "dismiss" }]);
  await navigating;
  assert.equal(page.url(), beforeUnloadUrl);
  await page.evaluate(() => { window.onbeforeunload = null; });
  checked("beforeunload cancellation through the independent recovery path");
  const panel = await fixture.context.newPage();
  await panel.goto(`chrome-extension://${fixture.extensionId}/popup.html`);
  const connectionControl = message => panel.evaluate(value => chrome.runtime.sendMessage(value), message);
  const nativeStatus = await connectionControl({ type: "GET_NATIVE_HOST_STATUS" });
  assert.equal(nativeStatus.status?.browserCompatible, true, JSON.stringify(nativeStatus));
  assert.equal(nativeStatus.status?.browserContractVersion, 1, JSON.stringify(nativeStatus));
  const inventory = await connectionControl({ type: "GET_HARNESS_CONNECTIONS" });
  assert.ok(inventory.result.clients.some(client => client.harness === "sdk" && client.phase === "used" && client.state === "responding"));
  const connectionId = inventory.result.clients.find(client => client.harness === "sdk").id;
  const protectedDisconnect = await connectionControl({ type: "DISCONNECT_HARNESS", params: { id: connectionId } });
  assert.match(protectedDisconnect.error, /Finish browser work/);
  let toolListChanges = 0;
  const runtimeDir = path.join(fixture.fixture, "runtime");
  const mcpEnv = { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: runtimeDir, OPENCODE_BROWSER_MEMORY: "0", AGENT_BROWSER_SESSION_ID: "connection-control-fixture",
    CODEX_HOME: path.join(fixture.fixture, "codex"), DSH_HOME: path.join(fixture.fixture, "dsh"), XDG_CONFIG_HOME: path.join(fixture.fixture, ".config"), CLAUDE_CONFIG_DIR: path.join(fixture.fixture, "claude") };
  mcp = new McpWorker(process.cwd(), [], mcpEnv, message => { if (message.method === "notifications/tools/list_changed") toolListChanges++; });
  await mcp.initialize({ protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "codex-control-fixture", version: "1.0" } });
  // The worker forwards the handshake only; like a real client, the fixture completes it.
  mcp.notification({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (let attempt = 0; attempt < 60 && !harnessControls(runtimeDir).some(row => row.harness === "codex"); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(harnessControls(runtimeDir).some(row => row.harness === "codex"), "the managed test worker owns a control endpoint before any CLI action");
  const mcpCall = async (name, args) => {
    const response = await mcp.request("tools/call", { name, arguments: args }, undefined, 20000);
    assert.ok(!response.error, JSON.stringify(response));
    return response.result.structuredContent ?? JSON.parse(response.result.content.find(item => item.type === "text").text);
  };
  const retained = await mcpCall("browser_run", { profile, sessionId: "retained-control-fixture", tab: { mode: "new" }, memoryMode: "off",
    steps: [{ action: "navigate", url: origin }], postObserve: { mode: "inspect", target: { selector: "#chosen" } } });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  const started = await connectionControl({ type: "START_HARNESS_RECONNECT", params: { target: "codex" } });
  assert.ok(started.result?.id, JSON.stringify(started));
  let completed = started.result;
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(completed.state); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    completed = (await connectionControl({ type: "GET_LOCAL_ACTION", params: { id: started.result.id } })).result;
  }
  assert.equal(completed.state, "succeeded", JSON.stringify(completed));
  assert.equal(completed.code, "refreshed"); assert.ok(toolListChanges > 0, "the harness receives the standard MCP catalog-refresh notification");
  const kept = await mcpCall("browser_observe", { profile, sessionId: "retained-control-fixture", mode: "inspect", target: { selector: "#chosen" } });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  const afterRefresh = await connectionControl({ type: "GET_HARNESS_CONNECTIONS" });
  assert.ok(afterRefresh.result.clients.some(client => client.id === connectionId), "other agents keep their existing browser socket");
  const retainedFinal = await mcpCall("browser_finalize", { profile, sessionId: "retained-control-fixture" });
  assert.equal(retainedFinal.ok, true);
  checked("extension button -> detached CLI -> scoped live MCP tool refresh, retained tabs and unrelated-agent continuity");
  await call("browser_finalize", {});
  const disconnected = await connectionControl({ type: "DISCONNECT_HARNESS", params: { id: connectionId } });
  assert.ok(disconnected.result, JSON.stringify(disconnected));
  assert.ok(!disconnected.result.clients.some(client => client.id === connectionId));
  await panel.close();
  checked("real connection inventory, active-work protection and targeted idle disconnect");
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/browser-reliability.json", JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  mcp?.close();
  agent?.close();
  await fixture?.cleanup();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
