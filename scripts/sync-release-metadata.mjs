import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Codex requires a literal manifest version; package.json owns its value. */
export function syncReleaseMetadata(root, { check = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version ?? "")) throw new Error("Invalid package version");
  const file = path.join(root, ".codex-plugin/plugin.json");
  const plugin = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plugin.version === pkg.version) return { version: pkg.version, changed: false };
  if (check) throw new Error("Codex manifest version is stale. Run npm run version to sync it from package.json.");
  plugin.version = pkg.version;
  fs.writeFileSync(file, JSON.stringify(plugin, null, 2) + "\n");
  return { version: pkg.version, changed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(syncReleaseMetadata(root, { check: process.argv.includes("--check") })));
}
