#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const hostDist = path.join(root, "native-host", "dist");

function cleanOutput(target) {
  const resolved = path.resolve(target);
  if (![dist, hostDist].includes(resolved) || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Unexpected build output path");
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (process.argv.includes("--clean")) {
  cleanOutput(dist);
  cleanOutput(hostDist);
  process.stdout.write(JSON.stringify({ ok: true, cleaned: dist }) + "\n");
  process.exit(0);
}

function compileDirectory(source, output) {
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    const target = path.join(output, entry.name.endsWith(".d.ts") ? entry.name : entry.name.replace(/\.ts$/, ".js"));
    if (entry.isDirectory()) { compileDirectory(input, target); continue; }
    if (!/\.(?:js|ts)$/.test(entry.name) || entry.name.endsWith(".d.ts")) { fs.copyFileSync(input, target); continue; }
    const sourceText = fs.readFileSync(input, "utf8").replaceAll("native-host/src/", "native-host/dist/");
    const compiled = ts.transpileModule(sourceText, {
      fileName: entry.name,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true, inlineSources: true, rewriteRelativeImportExtensions: true },
    });
    fs.writeFileSync(target, compiled.outputText);
    if (compiled.sourceMapText) fs.writeFileSync(`${target}.map`, compiled.sourceMapText);
  }
}
cleanOutput(dist);
cleanOutput(hostDist);
compileDirectory(path.join(root, "src"), dist);
compileDirectory(path.join(root, "native-host", "src"), hostDist);

for (const relative of ["cli/index.js", "adapters/mcp/server.js"]) {
  fs.chmodSync(path.join(dist, relative), 0o755);
}

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
