import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const productionRoots = ["src", "native-host/src", "extension-src"];
const failures = [];
const files = new Map();
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) walk(relative);
    else if (/\.(js|ts|tsx)$/.test(relative) && !relative.endsWith(".d.ts")) files.set(relative, fs.readFileSync(path.join(root, relative), "utf8"));
  }
}
for (const directory of productionRoots) walk(directory);

function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(root, path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js")]) {
    const relative = path.relative(root, candidate).replaceAll("\\", "/");
    if (files.has(relative)) return relative;
  }
  return null;
}

const graph = new Map([...files.keys()].map(file => [file, new Set()]));
for (const [relative, text] of files) {
  const lines = text.trimEnd().split(/\r?\n/).length;
  if (lines > 500) failures.push(`${relative}: ${lines} lines exceeds the 500-line production limit`);
  const add = specifier => {
    const target = resolveImport(relative, specifier);
    if (!target) return;
    graph.get(relative).add(target);
    if (relative.startsWith("src/shared/") && !target.startsWith("src/shared/")) failures.push(`${relative} reverses the shared boundary by importing ${target}`);
    if (relative.startsWith("src/core/") && /^(src\/(adapters|cli|control|management)\/|native-host\/|extension-src\/)/.test(target)) failures.push(`${relative} reverses the core boundary by importing ${target}`);
    if (relative.startsWith("src/browser/") && /^(src\/(adapters|cli|control|management)\/|native-host\/|extension-src\/)/.test(target)) failures.push(`${relative} reverses the browser boundary by importing ${target}`);
    if (relative.startsWith("native-host/src/") && target.startsWith("src/management/")) failures.push(`${relative} imports management implementation ${target}`);
  };
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g)) add(match[1]);
}

const state = new Map(), stack = [];
function visit(file) {
  state.set(file, 1); stack.push(file);
  for (const target of graph.get(file)) {
    if (!state.has(target)) visit(target);
    else if (state.get(target) === 1) failures.push(`import cycle: ${[...stack.slice(stack.indexOf(target)), target].join(" -> ")}`);
  }
  stack.pop(); state.set(file, 2);
}
for (const file of graph.keys()) if (!state.has(file)) visit(file);
if (failures.length) throw new Error([...new Set(failures)].join("\n"));
console.log(JSON.stringify({ ok: true, checked: files.size, maxLines: 500, cycles: 0, exceptions: 0 }));
