import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore, artifactUriTemplate } from "../artifacts.js";

test("artifact store returns URI metadata and reads content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-artifacts-test-"));
  const store = new ArtifactStore({ root, ttlMs: 60_000 });
  try {
    const meta = store.create({ sessionId: "session/a", mimeType: "application/json", data: { ok: true }, label: "result" });
    assert.match(meta.uri, /^browser:\/\/sessions\/session%2Fa\/artifacts\//);
    assert.equal("filePath" in meta, false);
    assert.deepEqual(JSON.parse(store.read(meta.uri).data.toString("utf8")), { ok: true });
    assert.equal(artifactUriTemplate(), "browser://sessions/{sessionId}/artifacts/{artifactId}");
  } finally {
    store.close();
  }
});

test("artifact store enforces its byte budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-artifacts-budget-"));
  const store = new ArtifactStore({ root, ttlMs: 60_000, maxBytes: 5 });
  try {
    const first = store.create({ sessionId: "s", data: "12345", mimeType: "text/plain" });
    const second = store.create({ sessionId: "s", data: "67890", mimeType: "text/plain" });
    assert.equal(store.read(first.uri), null);
    assert.equal(store.read(second.uri).data.toString(), "67890");
  } finally {
    store.close();
  }
});

test("artifact cleanup never removes untracked files from a configured root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-artifacts-shared-"));
  const unrelated = path.join(root, "keep.txt");
  fs.writeFileSync(unrelated, "user data");
  const store = new ArtifactStore({ root });
  store.create({ sessionId: "s", data: "temporary", mimeType: "text/plain" });
  store.close();
  assert.equal(fs.readFileSync(unrelated, "utf8"), "user data");
  fs.rmSync(root, { recursive: true, force: true });
});
