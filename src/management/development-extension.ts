import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withRuntimeLock } from "../../native-host/src/runtime-lifecycle.ts";
import { sourceFingerprint } from "../cli/source-fingerprint.ts";
import { atomicWrite } from "./transaction.ts";

export function developmentExtensionSource(dir: string): string | null {
  try { const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, "development-extension.json"), "utf8")); return typeof value === "object" && value !== null && "sourceRoot" in value && typeof value.sourceRoot === "string" ? value.sourceRoot : null; }
  catch { return null; }
}
function buildExtension(root: string) {
  execFileSync("bun", ["run", "build:extension"], { cwd: root, stdio: "pipe", timeout: 120000, windowsHide: true });
}
/** Refresh a stable unpacked path independently of the production runtime pointer. */
export async function publishDevelopmentExtension({ root, dir, output, dryRun = false, build = buildExtension }: {
  root: string; dir: string; output?: string; dryRun?: boolean; build?: (root: string) => void;
}) {
  root = path.resolve(root); dir = path.resolve(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string; version?: string };
  if (pkg.name !== "opencode-chromium" || !pkg.version || !fs.existsSync(path.join(root, "extension-src"))) throw new Error("Select an opencode-chromium source checkout with --source <directory>");
  let linked: { sourceRoot?: string; extensionPath?: string } = {};
  try { linked = JSON.parse(fs.readFileSync(path.join(dir, "development-extension.json"), "utf8")) as typeof linked; } catch { /* First local build. */ }
  const fingerprint = sourceFingerprint(root), extensionPath = path.resolve(output ?? (linked.sourceRoot === root && linked.extensionPath ? linked.extensionPath : path.join(dir, "extension")));
  if (extensionPath === root || root.startsWith(extensionPath + path.sep)) throw new Error("The extension output cannot replace a source checkout");
  if (extensionPath === path.join(root, "extension")) throw new Error("Use a separate unpacked output directory or source checkout so a failed build preserves the installed extension");
  if (fs.existsSync(extensionPath) && fs.readdirSync(extensionPath).length) {
    let previous: { name?: string } = {};
    try { previous = JSON.parse(fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8")) as typeof previous; } catch { /* Reject unrecognized directories below. */ }
    if (!["opencode-chromium", "opencode-browser-plugin", "__MSG_extensionName__"].includes(previous.name ?? "")) throw new Error("Output is not an existing OpenCode Browser extension; choose an empty directory");
  }
  const versionName = `${pkg.version} dev ${fingerprint.slice(0, 8)}`;
  if (dryRun) return { dryRun: true, sourceRoot: root, extensionPath, version: pkg.version, versionName, fingerprint };
  return withRuntimeLock(dir, () => {
    fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
    const stage = path.join(path.dirname(extensionPath), `development-extension-stage-${randomUUID()}`);
    const backup = path.join(dir, `development-extension-backup-${randomUUID()}`);
    const removeOwnedStage = (target: string) => {
      if (path.dirname(path.resolve(target)) !== path.dirname(extensionPath) || !path.basename(target).startsWith("development-extension-stage-")) throw new Error("Invalid extension staging path");
      fs.rmSync(target, { recursive: true, force: true });
    };
    let previous = false, published = false;
    try {
      build(root);
      if (sourceFingerprint(root) !== fingerprint) throw new Error("Sources changed during the extension build; run dev-extension again");
      const output = path.join(root, "extension");
      const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (manifest.version !== pkg.version || !fs.existsSync(path.join(output, "background.js"))) throw new Error("The extension build does not match the source package version");
      fs.cpSync(output, stage, { recursive: true });
      fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ ...manifest, version_name: versionName }, null, 2) + "\n");
      if (fs.existsSync(extensionPath)) { fs.renameSync(extensionPath, backup); previous = true; }
      fs.renameSync(stage, extensionPath); published = true;
      atomicWrite(path.join(dir, "development-extension.json"), JSON.stringify({ sourceRoot: root, extensionPath, version: pkg.version, fingerprint, builtAt: new Date().toISOString() }, null, 2) + "\n");
      return { refreshed: true, sourceRoot: root, extensionPath, version: pkg.version, versionName, fingerprint, ...(previous ? { backup } : {}),
        instruction: "Reload the unpacked extension at this exact path. Production runtime selection and provider credentials are unchanged." };
    } catch (error) {
      if (published) {
        // Move only our new build aside; retain the previous directory for rollback.
        fs.renameSync(extensionPath, stage);
      }
      if (previous) fs.renameSync(backup, extensionPath);
      throw error;
    } finally { if (fs.existsSync(stage)) removeOwnedStage(stage); }
  }, "development-extension.lock");
}
