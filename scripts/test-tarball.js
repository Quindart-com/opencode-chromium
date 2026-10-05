#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tarballName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
const tarball = process.argv[2] ?? path.join(root, tarballName);
if (!fs.existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-chromium-package-"));
try {
  // GNU tar reads a Windows drive letter as a remote host ("Cannot connect to
  // C:"), so the archive is named relative to its own directory and extracted
  // from there. The relative path works the same way on every platform.
  execFileSync("tar", ["-xzf", path.basename(tarball), "-C", temp], { cwd: path.dirname(tarball), stdio: "inherit" });
  const packageRoot = path.join(temp, "package");
  for (const relative of ["dist/core/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "dist/cli/index.js"]) {
    if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Tarball is missing ${relative}`);
  }
  for (const relative of ["src", "native-host/src", "scripts", "reports", "node_modules"]) {
    if (fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Tarball contains excluded source/local directory: ${relative}`);
  }
  for (const relative of ["native-host/dist/runtime.js", "extension/manifest.json", "skills/opencode-browser-plugin/SKILL.md", "dist/adapters/sdk/index.d.ts"]) {
    if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Tarball is missing ${relative}`);
  }
  execFileSync("bun", ["install", "--production", "--ignore-scripts"], { cwd: packageRoot, stdio: "pipe", windowsHide: true });
  const version = execFileSync("node", ["dist/cli/index.js", "version"], { cwd: packageRoot, encoding: "utf8", timeout: 15000, windowsHide: true });
  if (JSON.parse(version).version !== packageJson.version) throw new Error("Installed CLI version mismatch");
  execFileSync("node", ["--input-type=module", "-e", "await import('opencode-chromium/sdk'); await import('opencode-chromium/core'); await import('opencode-chromium/browser');"], { cwd: packageRoot, stdio: "pipe", timeout: 15000, windowsHide: true });
  console.log(JSON.stringify({ ok: true, tarball, packageRoot }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
