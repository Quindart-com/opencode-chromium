import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { findExecutable } from "./executable-discovery.ts";
export function npmNode() {
  const executable = process.versions.bun ? findExecutable("node") : process.execPath;
  if (!executable) throw new Error("Node.js and npm are required for automatic updates");
  return executable;
}
export function npmCliFile() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* Next installation. */ }
  }
  const file = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!file) throw new Error("npm unavailable");
  return file;
}
export async function npmMetadata({ cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<unknown> {
  // npm owns registry/proxy/auth configuration; credentials never enter stdout.
  return new Promise((resolve, reject) => execFile(npmNode(), [npmCliFile(), "view", "opencode-chromium@latest", "name", "version", "--json"],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, cwd, env }, (error, stdout) => {
      if (error) reject(new Error("release_unavailable")); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("invalid_release")); } }
    }));
}
