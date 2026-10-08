import fs from "node:fs";
import path from "node:path";
export function firefoxProfiles(root) {
  if (!root || !fs.existsSync(path.join(root, "profiles.ini"))) return [];
  const sections = fs.readFileSync(path.join(root, "profiles.ini"), "utf8").split(/(?=^\[)/m);
  return sections.filter(section => /^\[Profile\d+\]/.test(section)).flatMap(section => {
    const fields = Object.fromEntries(section.split(/\r?\n/).flatMap(line => { const i = line.indexOf("="); return i > 0 ? [[line.slice(0, i), line.slice(i + 1)]] : []; }));
    if (!fields.Path) return [];
    return [{ name: fields.Name, path: fields.IsRelative === "0" ? path.resolve(fields.Path) : path.resolve(root, fields.Path), default: fields.Default === "1" }];
  }).sort((a, b) => Number(b.default) - Number(a.default));
}
