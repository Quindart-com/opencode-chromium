import net from "node:net";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.js";
import { defaultIpcPath } from "../../native-host/src/ipc-path.js";
import { readProfileRegistrations, removeProfileRegistrationFile } from "../../native-host/src/profile-registry.js";

const DEFAULT_TIMEOUT_MS = 10000;
const PROFILE_STATUS_TIMEOUT_MS = 1000;

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
  constructor({ ipcPath = defaultIpcPath(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.ipcPath = ipcPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      const id = 1;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Timed out waiting for browser host response to ${method}`)), true);
      }, this.timeoutMs);

      const cleanup = () => clearTimeout(timeout);
      const finish = (settle, destroy = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroy) socket.destroy();
        else socket.end();
        settle();
      };
      const decoder = new FrameDecoder({
        onMessage: (message) => {
          let result;
          try {
            result = validateJsonRpcResponse(message, id, method);
          } catch (error) {
            finish(() => reject(error), true);
            return;
          }
          if (result === null) return;
          finish(() => resolve(result));
        },
      });

      socket.on("connect", () => {
        writeFrame(socket, { jsonrpc: "2.0", method, params, id }).catch((error) => {
          finish(() => reject(error), true);
        });
      });

      socket.on("data", (chunk) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          finish(() => reject(error), true);
        }
      });

      socket.on("error", (error) => {
        finish(() => reject(new Error(`Could not connect to OpenCode browser host at ${this.ipcPath}: ${error.message}`)), true);
      });

      socket.on("close", () => {
        finish(() => reject(new Error(`Browser host connection closed before response to ${method}`)));
      });

      socket.on("end", () => {
        finish(() => reject(new Error(`Browser host connection ended before response to ${method}`)));
      });
    });
  }
}

function profileIdFromParams(params = {}) {
  const id = params.profile_id ?? params.profileId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function publicProfile(profile) {
  return {
    profileId: profile.profileId,
    profileLabel: profile.profileLabel ?? null,
    browserName: profile.browserName ?? null,
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
    if (!profile) throw new Error(`Browser profile is not connected: ${profileId}`);
    return profile;
  }

  if (profiles.length === 1) return profiles[0];
  if (profiles.length === 0) throw new Error("No OpenCode Browser profiles are connected. Open a browser profile with the extension installed, then retry.");
  throw new Error("Multiple OpenCode Browser profiles are connected. Call browser_list_profiles, then browser_select_profile before using browser tools.");
}

async function statusForRegistration(registration, timeoutMs) {
  const client = new BrowserHostClient({ ipcPath: registration.ipcPath, timeoutMs });
  const status = await client.request("host.status");
  const profile = status?.profile && typeof status.profile === "object" ? status.profile : registration;
  return {
    ...registration,
    ...profile,
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
  const profiles = [];

  for (const registration of readProfileRegistrations()) {
    try {
      profiles.push(await statusForRegistration(registration, timeoutMs));
    } catch {
      removeProfileRegistrationFile(registration.registrationPath);
    }
  }

  profiles.sort((first, second) => String(first.profileLabel ?? first.profileId).localeCompare(String(second.profileLabel ?? second.profileId)));
  return includeInternal ? profiles : profiles.map(publicProfile);
}

export async function resolveBrowserProfile(profileId = null, options = {}) {
  const profiles = await listBrowserProfiles({ ...options, includeInternal: true });
  return chooseBrowserProfile(profiles, profileId);
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
  return new BrowserHostClient({ ...options, ipcPath }).request(method, params);
}
