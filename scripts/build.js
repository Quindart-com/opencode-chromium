#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

if (process.argv.includes("--clean")) {
  fs.rmSync(dist, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, cleaned: dist }) + "\n");
  process.exit(0);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, "src"), dist, { recursive: true });

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else files.push(path.relative(dist, absolute).replaceAll(path.sep, "/"));
  }
}
walk(dist);
const hash = createHash("sha256");
for (const file of files.sort()) hash.update(file).update(fs.readFileSync(path.join(dist, file)));
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  source: "src",
  files: files.length,
  sha256: hash.digest("hex"),
};
fs.writeFileSync(path.join(dist, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, dist, ...manifest }, null, 2)}\n`);
