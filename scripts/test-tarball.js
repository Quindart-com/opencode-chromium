#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarball = process.argv[2] ?? path.join(root, "opencode-browser-plugin-1.2.0.tgz");
if (!fs.existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-plugin-package-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", temp], { stdio: "inherit" });
  const packageRoot = path.join(temp, "package");
  for (const relative of ["dist/core/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "dist/cli/index.js"]) {
    if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`Tarball is missing ${relative}`);
  }
  console.log(JSON.stringify({ ok: true, tarball, packageRoot }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
