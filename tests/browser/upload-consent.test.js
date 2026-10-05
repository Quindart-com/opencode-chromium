import assert from "node:assert/strict";
import test from "node:test";
import { createUploadConsent } from "../../extension-src/entrypoints/background/upload-consent.js";
import { guardedCdp } from "../../extension-src/entrypoints/background/upload-gate.js";
import { createDebuggerAttacher } from "../../extension-src/entrypoints/background/debugger-attach.js";

function fixture(timeoutMs = 1000) {
  const settings = {}; let removed, navigated; const calls = [];
  const chrome = { runtime: { id: "extension", getURL: page => `chrome-extension://extension/${page}` }, storage: { local: {
    get: async () => settings, set: async value => Object.assign(settings, value),
  } }, tabs: { onUpdated: { addListener: listener => { navigated = listener; } } }, windows: { onRemoved: { addListener: listener => { removed = listener; } },
    create: async () => ({ id: 7, tabs: [{ id: 9 }] }), remove: async id => { calls.push(["close", id]); },
  } };
  const consent = createUploadConsent({ chrome, timeoutMs,
    describe: async files => ({ token: "request", files: files.map(path => ({ path, name: "photo.png", size: 12 })) }),
    snapshot: async () => { calls.push(["snapshot"]); return { files: ["approved-copy.png"] }; },
    release: async () => calls.push(["release"]),
  });
  const sender = { id: "extension", url: "chrome-extension://extension/upload-confirm.html?token=request", tab: { id: 9 } };
  return { consent, chrome, calls, sender, closed: () => removed(7), navigated: tabId => navigated(tabId, { url: "https://next.test" }) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("approved file copies survive attachment and are released when the destination page navigates", async () => {
  const f = fixture();
  const upload = f.consent.withFiles(["photo.png"], "https://example.test", async files => files, 42);
  await tick();
  await f.consent.message({ type: "RESOLVE_UPLOAD_REQUEST", token: "request", allow: true }, f.sender);
  await upload;
  assert.equal(f.calls.some(call => call[0] === "release"), false);
  f.navigated(42); await tick();
  assert.equal(f.calls.filter(call => call[0] === "release").length, 1);
});
test("default consent waits for the genuine extension window; agent and unrelated windows cannot approve", async () => {
  const f = fixture();
  let sent = false;
  const upload = f.consent.withFiles(["photo.png"], "https://example.test", async files => { sent = true; return files; });
  await tick(); assert.equal(sent, false);
  for (const sender of [{ ...f.sender, id: "agent" }, { ...f.sender, tab: { id: 123 } }, { ...f.sender, url: "chrome-extension://extension/popup.html" }]) {
    await assert.rejects(f.consent.message({ type: "RESOLVE_UPLOAD_REQUEST", token: "request", allow: true }, sender));
  }
  assert.equal(sent, false);
  await f.consent.message({ type: "RESOLVE_UPLOAD_REQUEST", token: "request", allow: true }, f.sender);
  assert.deepEqual(await upload, ["approved-copy.png"]);
  assert.equal(sent, true);
  await assert.rejects(f.consent.message({ type: "RESOLVE_UPLOAD_REQUEST", token: "request", allow: true }, f.sender), /expired/);
});
test("cancel, closing the window, and timeout each release files without uploading", async () => {
  for (const action of ["cancel", "close", "timeout"]) {
    const f = fixture(action === "timeout" ? 10 : 1000);
    let sent = false;
    const upload = f.consent.withFiles(["photo.png"], "https://example.test", async () => { sent = true; });
    const rejected = assert.rejects(upload, /no files were uploaded/);
    await tick();
    if (action === "cancel") await f.consent.message({ type: "RESOLVE_UPLOAD_REQUEST", token: "request", allow: false }, f.sender);
    if (action === "close") f.closed();
    await rejected; assert.equal(sent, false); assert.equal(f.calls.some(call => call[0] === "snapshot"), false);
    assert.equal(f.calls.some(call => call[0] === "release"), true);
  }
});
test("only the extension popup can opt in, and opting out restores consent", async () => {
  const f = fixture();
  const sender = { id: "extension", url: "chrome-extension://extension/popup.html" };
  assert.equal((await f.consent.message({ type: "GET_UPLOAD_SETTINGS" }, sender)).allowWithoutConfirmation, false);
  await assert.rejects(f.consent.message({ type: "SET_UPLOAD_SETTINGS", allowWithoutConfirmation: true }, { id: "extension", url: "https://example.test" }));
  await f.consent.message({ type: "SET_UPLOAD_SETTINGS", allowWithoutConfirmation: true }, sender);
  assert.deepEqual(await f.consent.withFiles(["photo.png"], "https://example.test", async files => files), ["approved-copy.png"]);
  assert.equal(f.calls.some(call => call[0] === "close"), false);
  await f.consent.message({ type: "SET_UPLOAD_SETTINGS", allowWithoutConfirmation: false }, sender);
  assert.equal((await f.consent.message({ type: "GET_UPLOAD_SETTINGS" }, sender)).allowWithoutConfirmation, false);
});
test("CDP uploads and file drags cannot bypass consent; navigation and picker bypasses fail", async () => {
  for (const method of ["DOM.setFileInputFiles", "Input.dispatchDragEvent"]) {
    let uploaded = false;
    await assert.rejects(guardedCdp({ method, commandParams: { files: ["file"], data: { files: ["file"] } }, tabId: 42,
      getTab: async () => ({ url: "https://example.test" }), consent: { withFiles: async () => { throw new Error("user denied"); } }, send: async () => { uploaded = true; } }), /denied/);
    assert.equal(uploaded, false);
  }
  await assert.rejects(guardedCdp({ method: "Page.setInterceptFileChooserDialog", commandParams: { enabled: false } }), /cannot enable/);
  await assert.rejects(guardedCdp({ method: "Page.navigate", commandParams: { url: "chrome-extension://extension/upload-confirm.html" } }), /extension UI/);
  await assert.rejects(guardedCdp({ method: "Target.attachToTarget", commandParams: {} }), /unavailable/);
  let calls = 0;
  await assert.rejects(guardedCdp({ method: "DOM.setFileInputFiles", commandParams: { files: ["file"] }, tabId: 42,
    getTab: async () => ({ url: ++calls === 1 ? "https://example.test" : "https://other.test" }),
    consent: { withFiles: async (files, url, send) => send(files) }, send: async () => assert.fail("must not upload") }), /destination changed/);
});
test("every agent debugger attachment intercepts the file picker; extension tabs are protected", async () => {
  const methods = [];
  const deps = { withTabLock: async (id, fn) => fn(), attachedTabs: new Map(), isBrowserInternalUrl: url => url.startsWith("chrome-extension:"),
    getTab: async () => ({ url: "https://example.test" }), chromeCall: async fn => fn(() => {}),
    chrome: { debugger: { attach: () => {}, detach: () => {} } }, DEBUGGER_VERSION: "1.3", errorMessage: String,
    sendCdpCommand: async (tabId, method) => methods.push(method), DEFAULT_CDP_TIMEOUT_MS: 1000 };
  await createDebuggerAttacher(deps)(42, "session");
  assert.deepEqual(methods, ["Page.enable", "Page.setInterceptFileChooserDialog"]);
  await assert.rejects(createDebuggerAttacher({ ...deps, getTab: async () => ({ url: "chrome-extension://extension/upload-confirm.html" }) })(99, "session"), /extension UI/);
});
