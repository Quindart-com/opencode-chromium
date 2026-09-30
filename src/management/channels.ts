import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./transaction.js";
import { sourceFingerprint } from "../cli/source-fingerprint.js";

export type Channel = "development" | "production";
export interface Activation {
  root: string;
  sourceRoot: string;
  channel: Channel;
  version: string;
  fingerprint: string;
  followBranch: boolean;
  pendingReload: boolean;
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}
export function branchChannel(branch: string, active: Channel = "development"): Channel {
  return branch === "HEAD" ? active : branch === "master" ? "production" : "development";
}
export function readActivation(dir: string): Activation | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as Activation; } catch { return null; }
}

/** Publish a complete verified snapshot before changing the active pointer. */
export async function activateChannel({ root, dir, dryRun = false, followBranch = true,
  busy = false, isBusy, build = defaultBuild }: { root: string; dir: string; dryRun?: boolean; followBranch?: boolean;
  busy?: boolean; isBusy?: () => Promise<boolean>; build?: (root: string) => void }) {
  const active = readActivation(dir);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const channel = branchChannel(branch, active?.channel);
  if (channel === "production" && git(root, ["status", "--porcelain"])) throw new Error("Production activation requires a clean master checkout");
  const fingerprint = sourceFingerprint(root);
  const destination = path.join(dir, "builds", channel, fingerprint);
  if (dryRun) return { dryRun, channel, fingerprint, destination, busy };
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "activation.lock");
  let descriptor: number;
  try { descriptor = fs.openSync(lock, "wx", 0o600); } catch { throw new Error("Another activation is running; retry after it completes"); }
  const stage = path.join(dir, `staging-${randomUUID()}`);
  try {
    if (!fs.existsSync(destination)) {
      build(root);
      if (sourceFingerprint(root) !== fingerprint) throw new Error("Sources changed during build; activation aborted");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-manifest.json"), "utf8"));
      if (manifest.sourceSha256 !== fingerprint) throw new Error("Build fingerprint mismatch");
      const extension = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (extension.version !== pkg.version) throw new Error("Extension/runtime version mismatch");
      for (const relative of ["dist", "native-host/dist", "extension", "skills", "package.json", "bun.lock"]) {
        const target = path.join(stage, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(root, relative), target, { recursive: true });
      }
      const dependencyKey = createHash("sha256").update(fs.readFileSync(path.join(root, "bun.lock"))).digest("hex");
      const dependencies = path.join(dir, "dependencies", dependencyKey);
      const dependencyReady = path.join(dependencies, "ready.json");
      if (!fs.existsSync(dependencyReady)) {
        fs.mkdirSync(dependencies, { recursive: true });
        fs.copyFileSync(path.join(root, "package.json"), path.join(dependencies, "package.json"));
        fs.copyFileSync(path.join(root, "bun.lock"), path.join(dependencies, "bun.lock"));
        execFileSync("bun", ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], { cwd: dependencies, stdio: "pipe", windowsHide: true });
        atomicWrite(dependencyReady, JSON.stringify({ lockfile: dependencyKey }) + "\n");
      }
      fs.symlinkSync(path.join(dependencies, "node_modules"), path.join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      execFileSync(process.execPath, [path.join(stage, "dist", "cli", "index.js"), "version"], { cwd: stage, stdio: "pipe", timeout: 10000, windowsHide: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(stage, destination);
    }
    const version = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8")).version as string;
    const activation: Activation = { root: destination, sourceRoot: root, channel, fingerprint, version, followBranch, pendingReload: true };
    if (busy || isBusy && await isBusy()) {
      atomicWrite(path.join(dir, "pending-activation.json"), JSON.stringify(activation, null, 2) + "\n");
      return { activated: false, pending: true, channel, reason: "Connected browser clients must finish and disconnect before activation" };
    }
    // Existing developer extension paths keep their ID. Windows directory replacement
    // uses a recoverable rename, and the runtime pointer changes only after publication.
    const extensionPath = path.join(dir, "extension");
    const previousExtension = path.join(dir, "extension-previous");
    if (fs.existsSync(previousExtension)) throw new Error("Previous extension rollback remains; resolve it before activation");
    if (fs.existsSync(extensionPath)) fs.renameSync(extensionPath, previousExtension);
    try {
      fs.cpSync(path.join(destination, "extension"), extensionPath, { recursive: true });
      atomicWrite(path.join(dir, "runtime.json"), JSON.stringify(activation, null, 2) + "\n");
    } catch (error) {
      if (fs.existsSync(extensionPath)) fs.rmSync(extensionPath, { recursive: true });
      if (fs.existsSync(previousExtension)) fs.renameSync(previousExtension, extensionPath);
      throw error;
    }
    if (fs.existsSync(previousExtension)) fs.rmSync(previousExtension, { recursive: true });
    if (fs.existsSync(path.join(dir, "pending-activation.json"))) fs.unlinkSync(path.join(dir, "pending-activation.json"));
    return { activated: true, ...activation, extensionPath, instruction: "Reload the developer extension and reconnect harnesses to use the new full-stack build" };
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}
function defaultBuild(root: string): void {
  execFileSync(process.execPath, [path.join(root, "scripts", "build.js")], { cwd: root, stdio: "pipe", windowsHide: true });
  execFileSync("bun", ["run", "build:extension"], { cwd: root, stdio: "pipe", windowsHide: true });
}
