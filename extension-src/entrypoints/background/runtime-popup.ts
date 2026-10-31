import type { Browser } from "wxt/browser";
import { browser as chrome } from "wxt/browser";
import { versionNotice } from "../../version-status.ts";
import { connectionPanelMessage } from "./connection-panel.ts";
import { NativeRpc } from "./native-rpc.ts";
import { popupMessageSchema,uploadMessageSchema } from "./popup-schema.ts";
import type { BackgroundRuntimeDependencies as Dependencies } from "./types.ts";

export function createPopupRuntime(dependencies: Dependencies) {
  const rpc = dependencies.rpc as NativeRpc;
  const { hostStatus, updateVersionBadge, connectionIdle, errorMessage, storageSet, VERSION_REMINDER_KEY, profileMetadata, publicProfile, setProfileLabel, sanitizeSemanticForPopup, uploadConsent, cursorArrivalWaiters, cursorWaiterKey, currentCursorStates } = dependencies;
const statusPorts = new Set<Browser.runtime.Port>();
const POPUP_MEMORY_METHODS = new Set([
    "memory.profiles",
    "memory.stats",
    "memory.configure",
    "memory.enable",
    "memory.disable",
    "memory.prune",
    "memory.reindex",
]);
function broadcastNativeStatus() {
    void updateVersionBadge();
    const payload = { type: "NATIVE_STATUS", status: { ...hostStatus } };
    for (const port of statusPorts) {
        try {
            port.postMessage(payload);
        }
        catch {
            statusPorts.delete(port);
        }
    }
}
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup-status")
        return;
    statusPorts.add(port);
    try {
        port.postMessage({ type: "STATUS_SNAPSHOT", status: { ...hostStatus } });
    }
    catch {
        statusPorts.delete(port);
        return;
    }
    port.onDisconnect.addListener(() => statusPorts.delete(port));
});
chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
    const parsed = popupMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (["GET_HARNESS_CONNECTIONS", "DISCONNECT_HARNESS", "RECONNECT_NATIVE_HOST", "START_HARNESS_RECONNECT", "RUN_CONNECTION_DOCTOR", "INSTALL_RUNTIME_UPDATE", "GET_LOCAL_ACTION", "GET_RUNTIME_UPDATES", "SET_RUNTIME_UPDATES"].includes(message.type)) {
        connectionPanelMessage(message, sender, { extensionId: chrome.runtime.id, panelUrl: chrome.runtime.getURL("/popup.html"), rpc, idle: connectionIdle })
            .then(result => sendResponse({ result })).catch(error => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (["GET_UPLOAD_SETTINGS", "SET_UPLOAD_SETTINGS", "GET_UPLOAD_REQUEST", "RESOLVE_UPLOAD_REQUEST"].includes(message?.type)) {
        const upload = uploadMessageSchema.safeParse(message);
        if (!upload.success) { sendResponse({ error: "Invalid upload request" }); return false; }
        uploadConsent.message(upload.data, sender).then((result: unknown) => sendResponse({ result })).catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SNOOZE_VERSION_NOTICE") {
        const notice = versionNotice(chrome.runtime.getManifest().version, hostStatus);
        if (!notice) {
            sendResponse({ ok: true });
            return false;
        }
        const reminder = { key: notice.key, until: Date.now() + 7 * 86400000 };
        storageSet({ [VERSION_REMINDER_KEY]: reminder }).then(() => {
            hostStatus.versionReminder = reminder;
            broadcastNativeStatus();
            sendResponse({ ok: true });
        }).catch(() => sendResponse({ ok: false }));
        return true;
    }
    if (message?.type === "MEMORY_CALL") {
        if (!message.method || !POPUP_MEMORY_METHODS.has(message.method)) {
            sendResponse({ ok: false, error: "Unsupported memory operation" });
            return false;
        }
        rpc.connect();
        rpc.request(message.method, message.params ?? {}, { timeoutMs: 60000 })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_HOST_STATUS" || message?.type === "GET_NATIVE_HOST_STATUS") {
        sendResponse({ status: hostStatus });
        return true;
    }
    if (message?.type === "GET_PROFILE") {
        profileMetadata()
            .then((profile: unknown) => sendResponse({ profile: publicProfile(profile) }))
            .catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_PROFILE_DETAILS") {
        profileMetadata()
            .then((profile: unknown) => sendResponse({ profile }))
            .catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SET_PROFILE_LABEL") {
        setProfileLabel(message.label)
            .then((profile: unknown) => sendResponse({ profile: publicProfile(profile) }))
            .catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (["GET_DECISION_SETTINGS", "SET_DECISION_SETTINGS", "TEST_DECISION_CONNECTION", "REMOVE_DECISION_KEY"].includes(message?.type)) {
        const decisionMethods: Record<string, string> = { GET_DECISION_SETTINGS: "decision.status", SET_DECISION_SETTINGS: "decision.configure",
            TEST_DECISION_CONNECTION: "decision.saveAndTest", REMOVE_DECISION_KEY: "decision.removeKey" };
        const method = decisionMethods[message.type];
        if (!method)
            return false;
        rpc.request(method, message.type === "TEST_DECISION_CONNECTION" ? { settings: message.settings, ...(message.apiKey ? { apiKey: message.apiKey } : {}) } : message.type === "SET_DECISION_SETTINGS" ? message.settings ?? {} : { usage: message.usage })
            .then((result) => sendResponse({ result }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_SEMANTIC_SETTINGS") {
        rpc.request("semantic.status", {})
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "GET_SEMANTIC_DIAGNOSTICS") {
        rpc.request("semantic.cacheDiagnostics", {})
            .then((diagnostics) => sendResponse({ diagnostics }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "SET_SEMANTIC_SETTINGS") {
        rpc.request("semantic.setSettings", {
            enabled: message.enabled === true,
            modelId: typeof message.modelId === "string" ? message.modelId : undefined,
            deepModelId: typeof message.deepModelId === "string" ? message.deepModelId : undefined,
            preload: message.preload === true,
            embeddingDims: Number.isInteger(message.embeddingDims) ? message.embeddingDims : undefined,
            strategyPreference: typeof message.strategyPreference === "string" ? message.strategyPreference : undefined,
            agentResultCount: Number.isInteger(message.agentResultCount) ? message.agentResultCount : undefined,
            agentResultDetail: typeof message.agentResultDetail === "string" ? message.agentResultDetail : undefined,
        })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "PREPARE_SEMANTIC_MODEL") {
        rpc.request("semantic.prepareModel", { modelId: typeof message.modelId === "string" ? message.modelId : undefined })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "DELETE_SEMANTIC_MODEL") {
        rpc.request("semantic.deleteModel", { modelId: typeof message.modelId === "string" ? message.modelId : undefined })
            .then((semantic) => sendResponse({ semantic: sanitizeSemanticForPopup(semantic) }))
            .catch((error) => sendResponse({ error: errorMessage(error) }));
        return true;
    }
    if (message?.type === "OPENCODE_CURSOR_ARRIVED") {
        const tabId = sender.tab?.id;
        const cursorId = typeof message.cursorId === "string" && message.cursorId.length > 0 ? message.cursorId : "default";
        const moveSequence = message.moveSequence;
        if (tabId !== undefined && Number.isInteger(tabId) && moveSequence !== undefined) {
            const waiter = cursorArrivalWaiters.get(cursorWaiterKey(tabId, cursorId, moveSequence));
            if (waiter)
                waiter();
        }
        sendResponse({ ok: true });
        return true;
    }
    if (message?.type === "OPENCODE_GET_CURSOR_STATE") {
        const tabId = sender.tab?.id;
        const states = tabId !== undefined && Number.isInteger(tabId) ? currentCursorStates(tabId) : [];
        sendResponse({ state: states[0] ?? null, states });
        return true;
    }
    return false;
});
  return { broadcastNativeStatus };
}
