#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { FrameDecoder, writeFrame } from "./framing.js";
import { instanceIpcPath, isUnixSocketPath } from "./ipc-path.js";
import { removeProfileRegistration, writeProfileRegistration } from "./profile-registry.js";
import { RpcRelay } from "./rpc-relay.js";
import { handleSemanticHostMethod } from "./semantic-search.js";
import { handleVisualHostMethod } from "./visual-map.js";

const PLUGIN_NAME = "opencode-browser-plugin";
const PROTOCOL_VERSION = "1";

const ipcPath = instanceIpcPath();
const state = { startedAt: new Date().toISOString(), ipcPath, profile: null };
let activeProfileId = null;

function registerProfile(profile) {
  if (activeProfileId && activeProfileId !== profile.profileId) {
    removeProfileRegistration(activeProfileId);
  }

  const registration = {
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
  };
  writeProfileRegistration(registration);
  state.profile = registration;
  activeProfileId = profile.profileId;
}

const relay = new RpcRelay({
  state,
  extensionWriter: (message) => writeFrame(process.stdout, message),
  onProfile: registerProfile,
  localHandler: async (method, params) => {
    const semantic = await handleSemanticHostMethod(method, params);
    if (semantic !== undefined) return semantic;
    return handleVisualHostMethod(method, params);
  },
});

function log(message) {
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
          log(`client message failed: ${error.message}`);
        });
      },
    });

    socket.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        log(`client frame decode failed: ${error.message}`);
        socket.destroy(error);
      }
    });
  });

  server.listen(ipcPath, () => log(`listening on ${ipcPath}`));
  server.on("error", (error) => {
    log(`ipc server error: ${error.message}`);
    process.exitCode = 1;
  });

  return server;
}

const server = createIpcServer();
let shutdownStarted = false;

function shutdownHost(reason, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log(reason);
  cleanupProfileRegistration();
  relay.shutdown(reason);
  server.close(() => {
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
      log(`extension message failed: ${error.message}`);
    });
  },
});

process.stdin.on("data", (chunk) => {
  try {
    nativeDecoder.push(chunk);
  } catch (error) {
    log(`native frame decode failed: ${error.message}`);
    process.exitCode = 1;
    process.stdin.destroy(error);
  }
});

process.stdin.on("end", () => shutdownHost("Browser extension disconnected"));
process.stdin.on("close", () => shutdownHost("Browser extension input closed"));
process.stdin.on("error", (error) => shutdownHost(`Browser extension input failed: ${error.message}`, 1));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdownHost(`Native host received ${signal}`));
}
