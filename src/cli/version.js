import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractMetadata, PLUGIN_VERSION } from "../core/versions.js";

export function packageInfo() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return { ...contractMetadata(), name: packageJson.name, version: packageJson.version, root };
  } catch {
    return { ...contractMetadata(), name: "opencode-browser-plugin", version: PLUGIN_VERSION, root };
  }
}
