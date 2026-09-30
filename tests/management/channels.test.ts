import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { activateChannel, branchChannel, readActivation } from "../../src/management/channels.ts";
import { sourceFingerprint } from "../../src/cli/source-fingerprint.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-channel-test-"));
  const root = path.join(directory, "repo");
  const dir = path.join(directory, "runtime");
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "dev");
  git("config", "user.name", "Synthetic Test");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.7.2" }));
  fs.writeFileSync(path.join(root, "bun.lock"), "synthetic-lock");
  git("add", "."); git("commit", "-m", "Synthetic fixture");
  const build = () => {
    for (const folder of ["dist/cli", "native-host/dist", "extension", "skills"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, "dist/build-manifest.json"), JSON.stringify({ sourceSha256: sourceFingerprint(root) }));
    fs.writeFileSync(path.join(root, "dist/cli/index.js"), "console.log('synthetic-version')");
    fs.writeFileSync(path.join(root, "extension/manifest.json"), JSON.stringify({ version: "1.7.2" }));
    const key = createHash("sha256").update("synthetic-lock").digest("hex");
    const dependencies = path.join(dir, "dependencies", key);
    fs.mkdirSync(path.join(dependencies, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dependencies, "ready.json"), JSON.stringify({ lockfile: key }));
  };
  return { root, dir, git, build, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
test("branch channels retain detached selection", () => {
  expect(branchChannel("master")).toBe("production");
  expect(branchChannel("feature/work")).toBe("development");
  expect(branchChannel("HEAD", "production")).toBe("production");
});
test("dry-run creates no runtime files and dirty master cannot activate", async () => {
  const f = fixture();
  try {
    await activateChannel({ ...f, dryRun: true });
    expect(fs.existsSync(f.dir)).toBe(false);
    f.git("checkout", "-b", "master");
    fs.writeFileSync(path.join(f.root, "dirty.txt"), "uncommitted");
    await expect(activateChannel(f)).rejects.toThrow("clean master");
    expect(fs.existsSync(f.dir)).toBe(false);
  } finally { f.cleanup(); }
});
test("complete snapshots activate, while busy or failed builds retain the working pointer", async () => {
  const f = fixture();
  try {
    const first = await activateChannel(f);
    expect(first.activated).toBe(true);
    const previous = fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8");
    const activeRoot = readActivation(f.dir)?.root;
    expect(activeRoot).not.toBe(f.root);
    fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ version: "1.7.3" }));
    const pending = await activateChannel({ ...f, busy: true, build: () => {
      f.build();
      fs.writeFileSync(path.join(f.root, "extension/manifest.json"), JSON.stringify({ version: "1.7.3" }));
    } });
    expect(pending.activated).toBe(false);
    expect(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")).toBe(previous);
    fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ version: "1.7.4" }));
    await expect(activateChannel({ ...f, build: () => { throw new Error("failed build"); } })).rejects.toThrow("failed build");
    expect(fs.readFileSync(path.join(f.dir, "runtime.json"), "utf8")).toBe(previous);
    expect(fs.existsSync(path.join(f.dir, "activation.lock"))).toBe(false);
  } finally { f.cleanup(); }
});
test("a competing activation cannot replace a working pointer", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, "activation.lock"), "held");
    await expect(activateChannel(f)).rejects.toThrow("Another activation");
    expect(fs.existsSync(path.join(f.dir, "runtime.json"))).toBe(false);
  } finally { f.cleanup(); }
});
