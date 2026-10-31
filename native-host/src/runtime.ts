#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { z } from "zod";
import { createParticipant,participantBusy,participants,processAlive } from "../../src/control/leases.ts";
import { runtimeDirectory } from "../../src/control/state.ts";
import { errorMessage } from "../../src/core/errors.ts";
import { instanceIpcPath,isUnixSocketPath } from "../../src/shared/node-files.ts";
import { FrameDecoder,writeFrame } from "../../src/shared/node-framing.ts";
import { PRODUCT } from "../../src/shared/product.ts";
import { normalizeProfileRegistration,readProfileRegistrations,removeProfileRegistration,writeProfileRegistration } from "../../src/shared/profile-registry.ts";
import type { ProfileHello } from "../../src/shared/rpc.ts";
import { record } from "../../src/shared/values.ts";
import { handleDecisionHostMethod } from "./decisions/index.ts";
import { selectRecipe } from "./decisions/recipes.ts";
import { decisionSearch } from "./decisions/search.ts";
import { handleDiagnosticsHostMethod } from "./diagnostics/index.ts";
import { createFirefoxHost } from "./firefox/backend.ts";
import { memoryCommandSchema } from "./memory/commands.ts";
import { EmbedQueue,MemoryStore,embeddingEnabled } from "./memory/index.ts";
import { candidateRecipes } from "./memory/recipe-candidates.ts";
import { configureNetworkFamilyFallback } from "./network-policy.ts";
import type { RelayState } from "./rpc-relay.ts";
import { RpcRelay } from "./rpc-relay.ts";
import { embedMemoryTexts,handleSemanticHostMethod,rankPageUnits } from "./semantic-search.ts";
import { rankInputSchema } from "./semantic-types.ts";
import { createUploadFiles } from "./uploads.ts";
import { handleVisualHostMethod } from "./visual-map.ts";

const PLUGIN_NAME = PRODUCT.pluginId;
const PROTOCOL_VERSION = "1";
configureNetworkFamilyFallback();

const ipcPath = instanceIpcPath();
const nativeHostVersion = z.string().parse(record(JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as unknown).version);
const hostActivity = createParticipant(runtimeDirectory(), "host", nativeHostVersion);
const state: RelayState = { startedAt: new Date().toISOString(), ipcPath, profile: null, nativeHostVersion };
let activeProfileId: string | null = null;

function registerProfile(profile: ProfileHello) {
  if (activeProfileId && activeProfileId !== profile.profileId) {
    removeProfileRegistration(activeProfileId);
  }

  const registration = normalizeProfileRegistration({
    ...profile,
    plugin: PLUGIN_NAME,
    protocolVersion: PROTOCOL_VERSION,
    connectionId: profile.connectionId ?? `${process.pid}-${state.startedAt}`,
    connectionGeneration: profile.connectionGeneration ?? 1,
    profileFingerprint: profile.profileFingerprint ?? profile.profileId,
    ipcPath,
    hostPid: process.pid,
    startedAt: state.startedAt,
    lastSeenAt: new Date().toISOString(),
  });
  if (!registration) throw new Error("Invalid browser registration");
  writeProfileRegistration(registration);
  state.profile = { ...registration, uploadConsentVersion: profile.uploadConsentVersion };
  activeProfileId = profile.profileId;
  memoryStore?.profiles.register(profile);
}

let memoryStore: MemoryStore | null = null;
const memoryQueue = new EmbedQueue({
  embed: embeddingEnabled() ? async (texts) => embedMemoryTexts(texts) : null,
  onResults: (rows, model, dims, embeddingProfile) => {
    if (!memoryStore) return;
    memoryStore.applyEmbeddings(rows, model, dims, embeddingProfile);
    if (model) memoryStore.writeMeta("model_id", model);
    if (Number.isInteger(dims)) memoryStore.writeMeta("dims", dims);
  },
});
if (embeddingEnabled()) memoryQueue.setQueryEmbedder(async (query) => {
  const result = await embedMemoryTexts([query]);
  return {
    vector: result?.vectors?.[0] ?? null,
    model: result?.model ?? null,
    dims: result?.dims ?? null,
    embeddingProfile: result?.embeddingProfile ?? null,
  };
});
try {
  memoryStore = new MemoryStore({ embedQueue: memoryQueue });
} catch (error) {
  log(`action memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
}
const uploadFiles = createUploadFiles();
const firefoxHost = createFirefoxHost({ getProfile: () => state.profile, onEvent: (tabId, method, params) => {
  void relay.requestExtension("firefox.event", { tabId, method, params }).catch(() => {});
} });
const relay: RpcRelay = new RpcRelay({
  state,
  extensionWriter: (message: unknown) => writeFrame(process.stdout, message),
  onProfile: registerProfile,
  admit: async () => { await hostActivity.enter(); return () => hostActivity.leave(); },
  canDisconnect: () => !participants(runtimeDirectory()).some(row => processAlive(row.pid) && participantBusy(row)),
  connectionDetails: () => ({}),
  localHandler: async (method, params): Promise<unknown> => {
    const firefox = await firefoxHost(method, params);
    if (firefox !== undefined) return firefox;
    if (method.startsWith("uploads.")) return uploadFiles(method, params);
    if (method === "runtime.activity") {
      const idle = await relay.requestExtension("runtime.canReconnect", {}, 1500).catch(() => null);
      return { ...relay.activity(), extensionIdle: record(idle).idle === true, nativeHostVersion };
    }
    if (method === "memory.selectRecipe" && memoryStore) return await selectRecipe(params?.intent,
      () => memoryStore ? candidateRecipes(memoryStore, { hostname: typeof params.hostname === "string" ? params.hostname : undefined, stepCount: typeof params.stepCount === "number" ? params.stepCount : undefined, profileId: activeProfileId ?? undefined }) : []) ?? { match: null };
    const decision = await handleDecisionHostMethod(method, params);
    if (decision !== undefined) return decision;
    if (method === "semantic.rankPageUnits") {
      const ranked = await decisionSearch(params, input => rankPageUnits(rankInputSchema.parse(input)), async () => {
        const result = await relay.requestExtension("decisionImage", params, 750);
        return typeof record(result).image === "string" ? String(record(result).image) : undefined;
      });
      if (ranked !== undefined) return ranked;
    }
    const semantic = await handleSemanticHostMethod(method, params);
    if (semantic !== undefined) return semantic;
    const visual = await handleVisualHostMethod(method, params);
    if (visual !== undefined) return visual;
    const diagnostics = handleDiagnosticsHostMethod(method, params);
    if (diagnostics !== undefined) return diagnostics;
    if (method.startsWith("memory.")) return handleMemoryHostMethod(method, params);
    return undefined;
  },
});

function handleMemoryHostMethod(method: string, input: unknown = {}) {
  const params = memoryCommandSchema.parse(input);
  if (method === "memory.profiles") {
    const connected = readProfileRegistrations().filter((profile) => {
      if (!profile.hostPid) return false;
      try { process.kill(profile.hostPid, 0); return true; } catch (error) { return record(error).code !== "ESRCH"; }
    });
    for (const profile of connected) memoryStore?.profiles.register(profile);
    const profiles = memoryStore?.profiles.list() ?? connected.map(({ profileId, profileLabel, browserName }) => ({ profileId, profileLabel, browserName }));
    return { currentProfileId: activeProfileId, profiles: profiles.map((profile: { profileId: string; }) => ({ ...profile, connected: connected.some((item) => item.profileId === profile.profileId) })) };
  }
  if (!memoryStore) {
    if (method === "memory.stats") {
      return { supported: false, enabled: false, health: "storage_unavailable", error: "No supported embedded SQLite runtime (bun:sqlite or node:sqlite)" };
    }
    return { error: "memory_storage_unavailable" };
  }
  if (method === "memory.captureState") return memoryStore.captureState();
  if (method === "memory.stats") return memoryStore.status(params);
  if (method === "memory.query") return memoryStore.query(params);
  if (method === "memory.search") return memoryStore.search({ ...params, profileId: activeProfileId });
  if (method === "memory.recipe") return memoryStore.findRecipe(params);
  if (method === "memory.configure") return memoryStore.configure(params);
  if (method === "memory.prune") return memoryStore.prune(params);
  if (method === "memory.enable") return memoryStore.enable();
  if (method === "memory.disable") return memoryStore.disable();
  if (method === "memory.pause") return memoryStore.pause();
  if (method === "memory.resume") return memoryStore.resume();
  if (method === "memory.recordStep") return memoryStore.recordStep({ ...params, success: params.success ?? true, profileId: activeProfileId });
  if (method === "memory.finalizeChain") return memoryStore.finalizeChain({ ...params, success: params.success ?? true, profileId: activeProfileId });
  if (method === "memory.usageEvent") return memoryStore.usageEvent({ ...params, eventType: z.string().parse(params.eventType), profileId: activeProfileId });
  if (method === "memory.reindex") {
    if (!memoryQueue.embed) throw new Error("Memory embeddings are disabled by configuration");
    return memoryStore.reindex({ embed: memoryQueue.embed });
  }
  throw new Error(`Unsupported memory method: ${method}`);
}

function log(message: string) {
  process.stderr.write(`[${PLUGIN_NAME}] ${message}\n`);
}

function prepareSocketPath() {
  if (!isUnixSocketPath(ipcPath)) return;
  if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
}

function cleanupSocketPath() {
  if (!isUnixSocketPath(ipcPath)) return;
  if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
}

function cleanupProfileRegistration() {
  if (activeProfileId) removeProfileRegistration(activeProfileId);
  activeProfileId = null;
}

function createIpcServer() {
  prepareSocketPath();

  const server = net.createServer((socket) => {
    relay.addClient(socket);

    const decoder = new FrameDecoder({
      onMessage: (message) => {
        relay.handleClientMessage(socket, message).catch((error) => {
          log(`client message failed: ${errorMessage(error)}`);
        });
      },
    });

    socket.on("data", (chunk) => {
      try {
        decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (error) {
        log(`client frame decode failed: ${errorMessage(error)}`);
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  server.listen(ipcPath, () => log(`listening on ${ipcPath}`));
  server.on("error", (error) => {
    log(`ipc server error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });

  return server;
}

const server = createIpcServer();
let shutdownStarted = false;

function shutdownHost(reason: string|undefined, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  hostActivity.close();
  log(reason ?? "Native host shutting down");
  relay.flushMemory();
  memoryStore?.close();
  cleanupProfileRegistration();
  relay.shutdown(reason);
  server.close(async () => {
    await firefoxHost.close();
    cleanupSocketPath();
    process.exit(exitCode);
  });
  const forceExit = setTimeout(() => {
    cleanupSocketPath();
    process.exit(exitCode);
  }, 2000);
  forceExit.unref?.();
}

const nativeDecoder = new FrameDecoder({
  onMessage: (message) => {
    relay.handleExtensionMessage(message).catch((error) => {
      log(`extension message failed: ${errorMessage(error)}`);
    });
  },
});

process.stdin.on("data", (chunk) => {
  try {
    nativeDecoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  } catch (error) {
    log(`native frame decode failed: ${errorMessage(error)}`);
    process.exitCode = 1;
    process.stdin.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

process.stdin.on("end", () => shutdownHost("Browser extension disconnected"));
process.stdin.on("close", () => shutdownHost("Browser extension input closed"));
process.stdin.on("error", (error) => shutdownHost(`Browser extension input failed: ${errorMessage(error)}`, 1));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdownHost(`Native host received ${signal}`));
}
