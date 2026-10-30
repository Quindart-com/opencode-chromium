import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncReleaseMetadata } from "../../scripts/sync-release-metadata.mjs";

test("release metadata follows package.json, preserves plugin fields and rejects drift without writing in CI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-metadata-"));
  try {
    fs.mkdirSync(path.join(root, ".codex-plugin"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.10.2" }));
    const file = path.join(root, ".codex-plugin/plugin.json");
    const initial = JSON.stringify({ name: "fixture", version: "1.10.1", requires_local_executor: true });
    fs.writeFileSync(file, initial);
    assert.throws(() => syncReleaseMetadata(root, { check: true }), /stale/);
    assert.equal(fs.readFileSync(file, "utf8"), initial);
    assert.deepEqual(syncReleaseMetadata(root), { version: "1.10.2", changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "fixture", version: "1.10.2", requires_local_executor: true });
    assert.deepEqual(syncReleaseMetadata(root, { check: true }), { version: "1.10.2", changed: false });
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^release-metadata-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
