import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUploadFiles } from "../../native-host/src/uploads.js";
import { RpcRelay } from "../../native-host/src/rpc-relay.js";
import { FrameDecoder } from "../../native-host/src/framing.js";

test("approved snapshots preserve the exact bytes and file names; changed files fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-files-test-"));
  const handle = createUploadFiles();
  try {
    const file = path.join(root, "private document.txt"); fs.writeFileSync(file, "approved content");
    const info = await handle("uploads.describe", { files: [file] });
    const copy = await handle("uploads.snapshot", { token: info.token });
    assert.equal(path.basename(copy.files[0]), "private document.txt");
    assert.equal(fs.readFileSync(copy.files[0], "utf8"), "approved content");
    await assert.rejects(handle("uploads.snapshot", { token: info.token }), /already used/);
    await handle("uploads.release", { token: info.token });
    assert.equal(fs.existsSync(copy.files[0]), false);
    const changed = await handle("uploads.describe", { files: [file] }); fs.writeFileSync(file, "swapped content");
    await assert.rejects(handle("uploads.snapshot", { token: changed.token }), /File changed/);
    await assert.rejects(handle("uploads.snapshot", { token: changed.token }), /expired/);
    await assert.rejects(handle("uploads.describe", { files: [root] }), /regular file/);
    await assert.rejects(handle("uploads.describe", { files: ["relative.txt"] }), /absolute/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("agent IPC cannot manufacture an upload snapshot or consume a consent request", async () => {
  let invoked = false; const replies = [];
  const decoder = new FrameDecoder({ onMessage: message => replies.push(message) });
  const socket = { write: (bytes, callback) => { decoder.push(bytes); callback?.(); return true; } };
  const relay = new RpcRelay({ state: {}, extensionWriter: async () => assert.fail("must not relay"), localHandler: async () => { invoked = true; } });
  await relay.handleClientMessage(socket, { id: 1, method: "uploads.snapshot", params: { token: "forged" } });
  assert.equal(invoked, false); assert.match(replies[0].error.message, /restricted to the extension/);
  await relay.handleClientMessage(socket, { id: 2, method: "executeCdp", params: { method: "DOM.setFileInputFiles", commandParams: { files: ["private.txt"] } } });
  assert.match(replies[1].error.message, /Reload the updated extension/);
});
