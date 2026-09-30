#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { sourceFingerprint } from "../src/cli/source-fingerprint.js";

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

// Use one checked compiler program. Module relocation is an AST transformation,
// so unrelated strings, comments, and browser expressions are never rewritten.
const stage = path.join(root, ".build");
const rootNames = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const input = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(input);
    else if (/\.(js|ts)$/.test(entry.name)) rootNames.push(input);
  }
}
collect(path.join(root, "src"));
collect(path.join(root, "native-host", "src"));
function outputPath(input) {
  const relative = path.relative(root, input).replaceAll(path.sep, "/");
  if (relative.startsWith("native-host/src/")) return path.join(hostDist, relative.slice(16).replace(/\.ts$/, ".js"));
  if (relative.startsWith("src/")) return path.join(dist, relative.slice(4).replace(/\.ts$/, ".js"));
  return input;
}
const options = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  rootDir: root, outDir: stage, allowJs: true, checkJs: false, strict: true, skipLibCheck: true,
  noUncheckedIndexedAccess: true, noEmitOnError: true, rewriteRelativeImportExtensions: true,
  sourceMap: true, inlineSources: false, declaration: true,
};
const program = ts.createProgram(rootNames, options);
const diagnostics = ts.getPreEmitDiagnostics(program);
function report(items) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(items, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
}
if (diagnostics.length) { report(diagnostics); process.exit(1); }
const relocate = context => source => {
  const rewrite = literal => {
    if (!ts.isStringLiteral(literal) || !literal.text.startsWith(".")) return literal;
    const target = path.resolve(path.dirname(source.fileName), literal.text);
    if (!target.includes(path.join("native-host", "src"))) return literal;
    let relative = path.relative(path.dirname(outputPath(source.fileName)), outputPath(target)).replaceAll(path.sep, "/");
    if (!relative.startsWith(".")) relative = "./" + relative;
    return context.factory.createStringLiteral(relative);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause, rewrite(node.moduleSpecifier), node.attributes);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return context.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, rewrite(node.moduleSpecifier), node.attributes);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) return context.factory.updateCallExpression(node, node.expression, node.typeArguments, [rewrite(node.arguments[0]), ...node.arguments.slice(1)]);
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(source, visit);
};
const emitted = program.emit(undefined, undefined, undefined, false, { before: [relocate], afterDeclarations: [relocate] });
if (emitted.emitSkipped || emitted.diagnostics.length) { report(emitted.diagnostics); process.exit(1); }
cleanOutput(dist); cleanOutput(hostDist);
fs.renameSync(path.join(stage, "src"), dist);
fs.renameSync(path.join(stage, "native-host", "src"), hostDist);
fs.rmSync(stage, { recursive: true, force: true });

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
  // Lets a launcher prove the bundle still matches the checked-out tree.
  sourceSha256: sourceFingerprint(root),
  files: files.length,
  sha256: hash.digest("hex"),
};
fs.writeFileSync(path.join(dist, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, dist, ...manifest }, null, 2)}\n`);
