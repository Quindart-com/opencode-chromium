import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PRODUCT } from "../shared/product.ts";

function executable(name: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const file = path.join(directory.replace(/^"|"$/g, ""), name + suffix);
      try { if (fs.statSync(file).isFile()) return path.resolve(file); } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export function npmNode() {
  const node = process.versions.bun ? executable("node") : process.execPath;
  if (!node) throw new Error("Node.js and npm are required for automatic updates");
  return node;
}

export function npmCliFile() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* Next installation. */ }
  }
  const file = candidates.find(candidate => candidate && path.basename(candidate) === "npm-cli.js" && fs.existsSync(candidate));
  if (!file) throw new Error("npm unavailable");
  return file;
}

export async function npmMetadata({ cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => execFile(npmNode(), [npmCliFile(), "view", `${PRODUCT.packageName}@latest`, "name", "version", "--json"],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, cwd, env }, (error, stdout) => {
      if (error) reject(new Error("release_unavailable")); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("invalid_release")); } }
    }));
}
