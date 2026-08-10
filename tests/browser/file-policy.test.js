import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFilePolicy, filePolicyFromEnv } from "../../src/browser/file-policy.js";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-policy-test-"));
  const inside = path.join(root, "allowed.txt");
  fs.writeFileSync(inside, "data");
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const deep = path.join(sub, "deep.txt");
  fs.writeFileSync(deep, "data");
  const outside = path.join(os.tmpdir(), `file-policy-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, "data");
  return { root, inside, deep, outside, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); } };
}

test("permissive policy keeps absolute, existing, readable file checks", () => {
  const { inside, cleanup } = sandbox();
  try {
    const policy = createFilePolicy({});
    assert.equal(policy.assertAllowed(inside).filePath, path.resolve(inside));
  } finally {
    cleanup();
  }
});

test("allowed roots accept files inside including nested paths", () => {
  const { root, inside, deep, cleanup } = sandbox();
  try {
    const policy = createFilePolicy({ allowedFileRoots: [root] });
    assert.equal(policy.assertAllowed(inside).allowedFileRoots.length, 1);
    assert.equal(policy.assertAllowed(deep).filePath, path.resolve(deep));
  } finally {
    cleanup();
  }
});

test("allowed roots reject sibling files and symlink escapes", () => {
  const { root, outside, cleanup } = sandbox();
  try {
    const policy = createFilePolicy({ allowedFileRoots: [root] });
    assert.throws(() => policy.assertAllowed(outside), (error) => {
      assert.equal(error.code, "FILE_POLICY_BLOCKED");
      return true;
    });
    const link = path.join(root, "escape.txt");
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    assert.throws(() => policy.assertAllowed(link), /outside the allowed roots/);
  } finally {
    cleanup();
  }
});

test("rejects parent traversal, relative paths, directories, and missing files", () => {
  const { root, cleanup } = sandbox();
  try {
    const policy = createFilePolicy({ allowedFileRoots: [root] });
    assert.throws(() => policy.assertAllowed(`${root}${path.sep}..${path.sep}outside.txt`), /parent traversal/);
    assert.throws(() => policy.assertAllowed("relative.txt"), /absolute/);
    assert.throws(() => policy.assertAllowed(path.join(root, "missing.txt")), /does not exist/);
    assert.throws(() => policy.assertAllowed(root), /not a file/);
  } finally {
    cleanup();
  }
});

test("env policy reads allowed file roots", () => {
  const policy = filePolicyFromEnv({ AGENT_BROWSER_ALLOWED_FILE_ROOTS: "/workspace,/tmp/opencode-browser" });
  assert.deepEqual(policy.allowedFileRoots, [path.resolve("/workspace"), path.resolve("/tmp/opencode-browser")]);
});