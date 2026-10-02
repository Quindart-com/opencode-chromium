const SETTINGS_KEY = "OPENCODE_UPLOAD_SETTINGS";
export function createUploadConsent({ chrome, describe, snapshot, release, timeoutMs = 60000 }) {
  const pending = new Map();
  const attached = new Map();
  const releaseTab = tabId => {
    const tokens = attached.get(tabId); attached.delete(tabId);
    for (const token of tokens ?? []) void release(token).catch(() => {});
  };
  chrome.tabs?.onRemoved?.addListener(releaseTab);
  chrome.tabs?.onUpdated?.addListener((tabId, changes) => { if (changes.url) releaseTab(tabId); });
  const ownPage = (sender, page) => sender?.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(page);
  const settle = (token, allowed) => {
    const request = pending.get(token);
    if (!request) return false;
    pending.delete(token); clearTimeout(request.timer);
    request.resolve(allowed);
    if (request.windowId) void chrome.windows.remove(request.windowId).catch(() => {});
    return true;
  };
  chrome.windows.onRemoved.addListener(windowId => {
    for (const [token, request] of pending) if (request.windowId === windowId) settle(token, false);
  });
  return {
    async withFiles(files, destination, upload, tabId) {
      const info = await describe(files);
      let retained = false;
      try {
        const settings = await chrome.storage.local.get(SETTINGS_KEY);
        if (settings[SETTINGS_KEY]?.allowWithoutConfirmation !== true) {
          if (pending.size >= 3) throw new Error("Too many pending uploads; wait for a user decision");
          const allowed = new Promise(resolve => {
            const timer = setTimeout(() => settle(info.token, false), timeoutMs);
            pending.set(info.token, { ...info, destination, resolve, timer });
          });
          try {
            const window = await chrome.windows.create({ url: chrome.runtime.getURL(`upload-confirm.html?token=${encodeURIComponent(info.token)}`), type: "popup", focused: true, width: 500, height: 560 });
            const request = pending.get(info.token);
            if (request) { request.windowId = window.id; request.tabId = window.tabs?.[0]?.id; }
            else if (window.id) void chrome.windows.remove(window.id).catch(() => {});
          } catch { settle(info.token, false); }
          if (!await allowed) throw new Error("Upload refused, closed, or timed out; no files were uploaded");
        }
        const prepared = await snapshot(info.token);
        const result = await upload(prepared.files);
        if (tabId != null) {
          const tokens = attached.get(tabId) ?? new Set(); tokens.add(info.token); attached.set(tabId, tokens);
          retained = true;
        }
        return result;
      } finally { if (!retained) await release(info.token).catch(() => {}); }
    },
    async message(message, sender) {
      if (["GET_UPLOAD_SETTINGS", "SET_UPLOAD_SETTINGS"].includes(message.type)) {
        if (!ownPage(sender, "popup.html")) throw new Error("Upload settings are restricted to the extension popup");
        if (message.type === "SET_UPLOAD_SETTINGS") {
          if (typeof message.allowWithoutConfirmation !== "boolean") throw new Error("Expected a boolean setting");
          await chrome.storage.local.set({ [SETTINGS_KEY]: { allowWithoutConfirmation: message.allowWithoutConfirmation } });
        }
        const value = await chrome.storage.local.get(SETTINGS_KEY);
        return { allowWithoutConfirmation: value[SETTINGS_KEY]?.allowWithoutConfirmation === true };
      }
      if (!ownPage(sender, "upload-confirm.html")) throw new Error("Upload consent requires the extension confirmation window");
      const request = pending.get(message.token);
      if (!request || new URL(sender.url).searchParams.get("token") !== message.token || (request.tabId && sender.tab?.id !== request.tabId)) throw new Error("Upload request expired or belongs to another window");
      if (message.type === "GET_UPLOAD_REQUEST") return { destination: request.destination, files: request.files.map(({ name, size, preview, path }) => ({ name, size, preview, path })) };
      if (message.type === "RESOLVE_UPLOAD_REQUEST") {
        if (typeof message.allow !== "boolean") throw new Error("Expected a user decision");
        settle(message.token, message.allow);
        return { resolved: true };
      }
      throw new Error("Unsupported upload message");
    },
  };
}
