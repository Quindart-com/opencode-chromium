import net from "node:net";
import { FrameDecoder,writeFrame } from "../../native-host/src/framing.ts";
import { defaultIpcPath } from "../../native-host/src/ipc-path.ts";
import { normalizeProfileRegistration,profileRegistryDir,readProfileRegistrations,type ProfileRegistration } from "../../native-host/src/profile-registry.ts";
import { ProfileSelectionError,type BrowserProfile } from "../core/profiles.ts";
import { PLUGIN_VERSION } from "../core/versions.ts";
import { BrowserRuntimeError } from "../core/errors.ts";
import { isRecord,record } from "../shared/values.ts";

const DEFAULT_TIMEOUT_MS = 20000;
const PROFILE_STATUS_TIMEOUT_MS = 1000;
const PROFILE_STATUS_RETRY_TIMEOUT_MS = 3000;
const PROFILE_CACHE_TTL_MS = 750;

const browserClients = new Map<string, BrowserHostClient>();
const profileCache = new Map<string, { at: number; profiles: ConnectedProfile[] }>();
interface ConnectedProfile extends ProfileRegistration { host: { connected: boolean; ipcClients: number | null; startedAt: string | null; lastExtensionMessageAt: string | null } }
interface ProfileOptions { timeoutMs?: number; includeInternal?: boolean; fresh?: boolean }
interface RequestOptions extends ProfileOptions { profileId?: string | null; ipcPath?: string }
interface Pending { method: string; resolve(value: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout> }

export class BrowserHostRpcError extends Error {
  readonly code: unknown;
  readonly data: unknown;
  readonly method: string | undefined;
  constructor(message: string | undefined, { code, data, method }: { code?: unknown; data?: unknown; method?: string } = {}) {
    super(message);
    this.name = "BrowserHostRpcError";
    this.code = record(data).code ?? code;
    this.data = data;
    this.method = method;
    Object.assign(this, record(data));
  }
}

export function validateJsonRpcResponse(input: unknown, expectedId: number | string, method = "unknown") {
  if (!isRecord(input)) throw new Error(`Invalid browser host response to ${method}: expected object`);
  const message = record(input);
  if (!message || typeof message !== "object") throw new Error(`Invalid browser host response to ${method}: expected object`);
  if (message.jsonrpc !== "2.0") throw new Error(`Invalid browser host response to ${method}: missing jsonrpc 2.0`);
  if (message.id !== expectedId) return null;

  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw new Error(`Invalid browser host response to ${method}: expected exactly one of result or error`);
  if (hasError) {
    const error = record(message.error);
    throw new BrowserHostRpcError(typeof error.message === "string" ? error.message : "Browser host RPC error", {
      code: error.code,
      data: error.data,
      method,
    });
  }
  return message.result;
}

export class BrowserHostClient {
  readonly ipcPath: string;
  readonly timeoutMs: number;
  #socket: net.Socket | null = null;
  #connectPromise: Promise<net.Socket> | null = null;
  #decoder: FrameDecoder | null = null;
  #pending = new Map<number, Pending>();
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

    this.#connectPromise = new Promise<net.Socket>((resolve, reject) => {
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
          this.#decoder?.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (error) {
          this.#disconnect(error);
        }
      });
      socket.on("error", (error) => {
        const wrapped = Object.assign(new Error(`Could not connect to the agent browser host at ${this.ipcPath}: ${error.message}`, { cause: error }), { code: (error as NodeJS.ErrnoException).code });
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

  #handleMessage(input: unknown) {
    const message = record(input);
    if (!message || typeof message !== "object" || typeof message.id !== "number") return;
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

  #settle(id: number, settle: () => void) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    settle();
  }

  #disconnect(error: unknown) {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#connectPromise = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const [id, pending] of this.#pending) {
      this.#settle(id, () => pending.reject(error));
    }
  }

  async request(method: string, params: object = {}, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const socket = await this.#connect();
    const id = this.#nextRequestId++;
    const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#settle(id, () => reject(new Error(`Timed out waiting for browser host response to ${method}`)));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
      writeFrame(socket, { jsonrpc: "2.0", method, params: { ...params, deadlineAt: record(params).deadlineAt ?? Date.now() + Math.max(1, timeoutMs - 10000) }, id, clientVersion: PLUGIN_VERSION, coordinated: process.env.OPENCODE_BROWSER_COORDINATED === "1" }).catch((error) => {
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

function pooledBrowserClient(ipcPath: string, _options: { timeoutMs?: number } = {}) {
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

function profileIdFromParams(params: Record<string, unknown> = {}) {
  const id = params.profile_id ?? params.profileId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function publicProfile(profile: ProfileRegistration) {
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

export function chooseBrowserProfile<T extends BrowserProfile>(profiles: T[], profileId: string | null = null): T {
  if (profileId) {
    const profile = profiles.find(candidate => candidate.profileId === profileId);
    if (!profile) throw new ProfileSelectionError("PROFILE_DISCONNECTED", "Browser profile is not connected: " + profileId);
    return profile;
  }
  const first = profiles[0];
  if (profiles.length === 1 && first) return first;
  if (!profiles.length) throw new ProfileSelectionError("NO_BROWSER_PROFILE", "No browser profiles are connected. Open a browser profile with the extension installed, then retry.");
  const labels = new Map<string, T[]>();
  for (const profile of profiles) { const label = profile.profileLabel?.toLocaleLowerCase(); if (label) labels.set(label, [...(labels.get(label) ?? []), profile]); }
  const duplicates = [...labels.values()].some(matches => matches.length > 1);
  throw new ProfileSelectionError(duplicates ? "PROFILE_LABEL_AMBIGUOUS" : "PROFILE_SELECTION_REQUIRED", duplicates ? "Multiple connected profiles share a label; select by profile ID." : "Multiple browser profiles are connected; select an exact profile ID or label.", profiles);
}

async function statusForRegistration(registration: ProfileRegistration, timeoutMs: number): Promise<ConnectedProfile> {
  const client = pooledBrowserClient(registration.ipcPath, { timeoutMs });
  const status = record(await client.request("host.status", {}, { timeoutMs }));
  const profile = normalizeProfileRegistration({ ...registration, ...record(status.profile) }) ?? registration;
  return {
    ...registration,
    ...profile,
    profileFingerprint: profile.profileFingerprint ?? registration.profileFingerprint ?? registration.profileId,
    connectionId: profile.connectionId ?? registration.connectionId ?? null,
    connectionGeneration: profile.connectionGeneration ?? registration.connectionGeneration ?? 1,
    host: {
      connected: status?.connected === true,
      ipcClients: typeof status.ipcClients === "number" ? status.ipcClients : null,
      startedAt: typeof status.startedAt === "string" ? status.startedAt : registration.startedAt ?? null,
      lastExtensionMessageAt: typeof status.lastExtensionMessageAt === "string" ? status.lastExtensionMessageAt : null,
    },
  };
}

export function listBrowserProfiles(options: ProfileOptions & { includeInternal: true }): Promise<ConnectedProfile[]>;
export function listBrowserProfiles(options?: ProfileOptions): Promise<ReturnType<typeof publicProfile>[]>;
export async function listBrowserProfiles(options: ProfileOptions = {}) {
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : PROFILE_STATUS_TIMEOUT_MS;
  const includeInternal = options.includeInternal === true;
  const cacheKey = profileRegistryDir();
  const cached = profileCache.get(cacheKey);
  let profiles;

  if (options.fresh !== true && cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) {
    profiles = cached.profiles;
  } else {
    const registrations = readProfileRegistrations();
    const settled = await Promise.allSettled(registrations.map(async registration => {
      try { return await statusForRegistration(registration, timeoutMs); }
      catch (error) {
        // A status read is safe to repeat. Give a busy host one bounded chance
        // to answer; explicit caller budgets and mutations are never retried here.
        if (options.timeoutMs !== undefined || !(error instanceof Error) || !/Timed out waiting for browser host response to host[.]status/.test(error.message)) throw error;
        return statusForRegistration(registration, PROFILE_STATUS_RETRY_TIMEOUT_MS);
      }
    }));
    profiles = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result?.status === "fulfilled") profiles.push(result.value);
      // A busy live host can miss a probe; only the owner removes its registration.
    }
    if (registrations.length && !profiles.length) {
      const failures = settled.filter(result => result.status === "rejected").map(result => result.reason as unknown);
      const denied = failures.some(error => ["EPERM", "EACCES"].includes(String(record(error).code)));
      const timedOut = failures.some(error => error instanceof Error && /Timed out/.test(error.message));
      if (denied || timedOut) throw new BrowserRuntimeError(denied ?
        "A browser host is registered, but this process cannot access it. Allow the local host connection or run the MCP server outside the restricted sandbox; reinstalling the extension will not grant access." :
        "A browser host is registered but did not answer its status probe. Run opencode-chromium doctor --repair-runtime --json, then retry; if it persists, reconnect the extension.",
      { code: denied ? "BROWSER_HOST_ACCESS_DENIED" : "BROWSER_HOST_UNRESPONSIVE", retryable: !denied, uncertain: false });
    }
    profiles.sort((first, second) => String(first.profileLabel ?? first.profileId).localeCompare(String(second.profileLabel ?? second.profileId)));
    profileCache.set(cacheKey, { at: Date.now(), profiles });
  }
  return includeInternal ? profiles : profiles.map(publicProfile);
}

export async function resolveBrowserProfile(profileId: string | null = null, options: ProfileOptions = {}) {
  const profiles = await listBrowserProfiles({ ...options, includeInternal: true });
  try {
    return chooseBrowserProfile(profiles, profileId);
  } catch (error) {
    if (profileId && record(error).code === "PROFILE_DISCONNECTED" && options.fresh !== true) {
      const freshProfiles = await listBrowserProfiles({ ...options, fresh: true, includeInternal: true });
      return chooseBrowserProfile(freshProfiles, profileId);
    }
    throw error;
  }
}

async function aggregateHostStatus(options: ProfileOptions = {}) {
  const profiles = await listBrowserProfiles(options);
  return {
    connected: profiles.length > 0,
    profileCount: profiles.length,
    profiles,
  };
}

export async function browserRequest(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
  const requestedProfileId = options.profileId ?? profileIdFromParams(params);
  if (method === "host.status" && !requestedProfileId && !options.ipcPath) {
    return aggregateHostStatus(options);
  }

  const profile = options.ipcPath ? null : await resolveBrowserProfile(requestedProfileId, options);
  const ipcPath = options.ipcPath ?? profile?.ipcPath;
  if (!ipcPath) throw new Error("Browser profile has no native host connection");
  try {
    return await pooledBrowserClient(ipcPath, options).request(method, params, options);
  } catch (error) {
    invalidateBrowserProfileCache();
    throw error;
  }
}
