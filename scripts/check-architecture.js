import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const exceptions = JSON.parse(fs.readFileSync(path.join(root, "architecture-exceptions.json"), "utf8"));
const failures = [];
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(relative);
    else if (/\.(js|ts|tsx)$/.test(relative)) {
      checked++;
      const text = fs.readFileSync(path.join(root, relative), "utf8");
      const lines = text.split(/\r?\n/).length;
      const budget = exceptions[relative]?.maxLines ?? 500;
      if (lines > budget) failures.push(`${relative}: ${lines} lines exceeds ${budget}; split responsibilities or document a reviewed exception`);
      const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith(".")) continue;
        const target = path.relative(root, path.resolve(root, path.dirname(relative), specifier)).replaceAll("\\", "/");
        if (relative.startsWith("native-host/src/decisions/") && !target.startsWith("native-host/src/")) failures.push(`${relative} imports outside native-host ownership: ${target}`);
        if (relative.startsWith("src/management/") && /^src\/(adapters|browser|core)\//.test(target)) failures.push(`${relative} imports browser orchestration: ${target}`);
      }
    }
  }
}
for (const directory of ["src", "native-host/src", "extension-src"]) walk(directory);
if (failures.length) throw new Error(failures.join("\n"));
console.log(JSON.stringify({ ok: true, checked, newModuleMaxLines: 500 }));
