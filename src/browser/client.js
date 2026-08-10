import net from "node:net";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.js";
import { defaultIpcPath } from "../../native-host/src/ipc-path.js";
import { profileRegistryDir, readProfileRegistrations, removeProfileRegistrationFile } from "../../native-host/src/profile-registry.js";

const DEFAULT_TIMEOUT_MS = 10000;
const PROFILE_STATUS_TIMEOUT_MS = 1000;
const PROFILE_CACHE_TTL_MS = 750;

const browserClients = new Map();
const profileCache = new Map();

export class BrowserHostRpcError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = "BrowserHostRpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export function validateJsonRpcResponse(message, expectedId, method = "unknown") {
  if (!message || typeof message !== "object") throw new Error(`Invalid browser host response to ${method}: expected object`);
  if (message.jsonrpc !== "2.0") throw new Error(`Invalid browser host response to ${method}: missing jsonrpc 2.0`);
  if (message.id !== expectedId) return null;

  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw new Error(`Invalid browser host response to ${method}: expected exactly one of result or error`);
  if (hasError) {
    const error = message.error && typeof message.error === "object" ? message.error : {};
    throw new BrowserHostRpcError(error.message ?? "Browser host RPC error", {
      code: error.code,
      data: error.data,
      method,
    });
  }
  return message.result;
}

export class BrowserHostClient {
  #socket = null;
  #connectPromise = null;
  #decoder = null;
  #pending = new Map();
  #nextRequestId = 1;
  #closed = false;

  constructor({ ipcPath = defaultIpcPath(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.ipcPath = ipcPath;
    this.timeoutMs = timeoutMs;
  }

  async #connect() {
    if (this.#closed) throw new Error(`Browser host client is closed: ${this.ipcPath}`);
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      let connected = false;
      this.#socket = socket;
      this.#decoder = new FrameDecoder({
        onMessage: (message) => this.#handleMessage(message),
      });

      socket.once("connect", () => {
        connected = true;
        resolve(socket);
      });
      socket.on("data", (chunk) => {
        try {
          this.#decoder?.push(chunk);
        } catch (error) {
          this.#disconnect(error);
        }
      });
      socket.on("error", (error) => {
        const wrapped = new Error(`Could not connect to the agent browser host at ${this.ipcPath}: ${error.message}`);
        if (!connected) reject(wrapped);
        this.#disconnect(wrapped);
      });
      socket.on("close", () => {
        this.#disconnect(new Error(`Browser host connection closed: ${this.ipcPath}`));
      });
      socket.on("end", () => {
        this.#disconnect(new Error(`Browser host connection ended: ${this.ipcPath}`));
      });
    });

    try {
      return await this.#connectPromise;
    } finally {
      if (!this.#socket || this.#socket.destroyed) this.#connectPromise = null;
    }
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object" || message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    let result;
    try {
      result = validateJsonRpcResponse(message, message.id, pending.method);
    } catch (error) {
      this.#settle(message.id, () => pending.reject(error));
      return;
    }
    this.#settle(message.id, () => pending.resolve(result));
  }

  #settle(id, settle) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    settle();
  }

  #disconnect(error) {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#connectPromise = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const [id, pending] of this.#pending) {
      this.#settle(id, () => pending.reject(error));
    }
  }

  async request(method, params = {}, options = {}) {
    const socket = await this.#connect();
    const id = this.#nextRequestId++;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#settle(id, () => reject(new Error(`Timed out waiting for browser host response to ${method}`)));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
      writeFrame(socket, { jsonrpc: "2.0", method, params, id }).catch((error) => {
        this.#settle(id, () => reject(error));
        this.#disconnect(error);
      });
    });
  }

  close() {
    this.#closed = true;
    this.#disconnect(new Error(`Browser host client closed: ${this.ipcPath}`));
  }
}

function pooledBrowserClient(ipcPath, options = {}) {
  let client = browserClients.get(ipcPath);
  if (!client) {
    client = new BrowserHostClient({ ipcPath, timeoutMs: DEFAULT_TIMEOUT_MS });
    browserClients.set(ipcPath, client);
  }
  return client;
}

export function closeBrowserClients() {
  for (const client of browserClients.values()) client.close();
  browserClients.clear();
  profileCache.clear();
}

export function invalidateBrowserProfileCache() {
  profileCache.delete(profileRegistryDir());
}

function profileIdFromParams(params = {}) {
  const id = params.profile_id ?? params.profileId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function publicProfile(profile) {
  return {
    profileId: profile.profileId,
    profileLabel: profile.profileLabel ?? null,
    profileFingerprint: profile.profileFingerprint ?? profile.profileId,
    connectionId: profile.connectionId ?? null,
    connectionGeneration: profile.connectionGeneration ?? null,
    browserName: profile.browserName ?? null,
    browserVersion: profile.browserVersion ?? null,
    extensionId: profile.extensionId ?? null,
    extensionVersion: profile.extensionVersion ?? null,
    hostPid: profile.hostPid ?? null,
    startedAt: profile.startedAt ?? null,
    lastSeenAt: profile.lastSeenAt ?? null,
  };
}

export function chooseBrowserProfile(profiles, profileId = null) {
  if (profileId) {
    const profile = profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) {
      const error = new Error(`Browser profile is not connected: ${profileId}`);
      error.code = "PROFILE_DISCONNECTED";
      error.retryable = true;
      throw error;
    }
    return profile;
  }

  if (profiles.length === 1) return profiles[0];
  if (profiles.length === 0) {
    const error = new Error("No browser profiles are connected. Open a Chromium profile with the extension installed, then retry.");
    error.code = "NO_BROWSER_PROFILE";
    throw error;
  }
  const labels = new Map();
  for (const profile of profiles) {
    const label = profile.profileLabel?.toLocaleLowerCase();
    if (label) labels.set(label, [...(labels.get(label) ?? []), profile]);
  }
  const duplicateLabels = [...labels.values()].filter((matches) => matches.length > 1).flat().map(publicProfile);
  const error = new Error(duplicateLabels.length > 0
    ? "Multiple connected profiles share a label; select by profile ID."
    : "Multiple browser profiles are connected; select an exact profile ID or label.");
  error.code = duplicateLabels.length > 0 ? "PROFILE_LABEL_AMBIGUOUS" : "PROFILE_SELECTION_REQUIRED";
  error.profiles = profiles.map(publicProfile);
  throw error;
}

async function statusForRegistration(registration, timeoutMs) {
  const client = pooledBrowserClient(registration.ipcPath, { timeoutMs });
  const status = await client.request("host.status", {}, { timeoutMs });
  const profile = status?.profile && typeof status.profile === "object" ? status.profile : registration;
  return {
    ...registration,
    ...profile,
    profileFingerprint: profile.profileFingerprint ?? registration.profileFingerprint ?? registration.profileId,
    connectionId: profile.connectionId ?? registration.connectionId ?? null,
    connectionGeneration: profile.connectionGeneration ?? registration.connectionGeneration ?? 1,
    host: {
      connected: status?.connected === true,
      ipcClients: status?.ipcClients ?? null,
      startedAt: status?.startedAt ?? registration.startedAt ?? null,
      lastExtensionMessageAt: status?.lastExtensionMessageAt ?? null,
    },
  };
}

export async function listBrowserProfiles(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : PROFILE_STATUS_TIMEOUT_MS;
  const includeInternal = options.includeInternal === true;
  const cacheKey = profileRegistryDir();
  const cached = profileCache.get(cacheKey);
  let profiles;

  if (options.fresh !== true && cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) {
    profiles = cached.profiles;
  } else {
    const registrations = readProfileRegistrations();
    const settled = await Promise.allSettled(registrations.map((registration) => statusForRegistration(registration, timeoutMs)));
    profiles = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "fulfilled") profiles.push(result.value);
      else removeProfileRegistrationFile(registrations[index].registrationPath);
    }
    profiles.sort((first, second) => String(first.profileLabel ?? first.profileId).localeCompare(String(second.profileLabel ?? second.profileId)));
    profileCache.set(cacheKey, { at: Date.now(), profiles });
  }
  return includeInternal ? profiles : profiles.map(publicProfile);
}

export async function resolveBrowserProfile(profileId = null, options = {}) {
  const profiles = await listBrowserProfiles({ ...options, includeInternal: true });
  try {
    return chooseBrowserProfile(profiles, profileId);
  } catch (error) {
    if (profileId && error?.code === "PROFILE_DISCONNECTED" && options.fresh !== true) {
      const freshProfiles = await listBrowserProfiles({ ...options, fresh: true, includeInternal: true });
      return chooseBrowserProfile(freshProfiles, profileId);
    }
    throw error;
  }
}

async function aggregateHostStatus(options = {}) {
  const profiles = await listBrowserProfiles(options);
  return {
    connected: profiles.length > 0,
    profileCount: profiles.length,
    profiles,
  };
}

export async function browserRequest(method, params = {}, options = {}) {
  const requestedProfileId = options.profileId ?? profileIdFromParams(params);
  if (method === "host.status" && !requestedProfileId && !options.ipcPath) {
    return aggregateHostStatus(options);
  }

  const profile = options.ipcPath ? null : await resolveBrowserProfile(requestedProfileId, options);
  const ipcPath = options.ipcPath ?? profile.ipcPath;
  try {
    return await pooledBrowserClient(ipcPath, options).request(method, params, options);
  } catch (error) {
    invalidateBrowserProfileCache();
    throw error;
  }
}
