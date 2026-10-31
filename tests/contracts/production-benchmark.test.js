import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

test("production benchmark rejects Bun before creating a browser fixture", () => {
  const result = spawnSync("bun", ["scripts/benchmark-production-flow.js", "unused-report.json", "1"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run this benchmark with Node, not Bun/);
  assert.doesNotMatch(result.stderr, /Starting disposable browser and host/);
});
