#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { FrameDecoder, writeFrame } from "./framing.js";
import { defaultIpcPath, isUnixSocketPath } from "./ipc-path.js";
import { RpcRelay } from "./rpc-relay.js";

const ipcPath = defaultIpcPath();
const state = { startedAt: new Date().toISOString() };

const relay = new RpcRelay({
  state,
  extensionWriter: (message) => writeFrame(process.stdout, message),
});

function log(message) {
  process.stderr.write(`[opencode-browser-host] ${message}\n`);
}

function prepareSocketPath() {
  if (!isUnixSocketPath(ipcPath)) return;
  if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
}

function cleanupSocketPath() {
  if (!isUnixSocketPath(ipcPath)) return;
  if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
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

process.stdin.on("end", () => {
  log("extension disconnected");
  server.close(() => cleanupSocketPath());
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      cleanupSocketPath();
      process.exit(0);
    });
  });
}
