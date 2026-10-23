import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractMetadata,PLUGIN_VERSION } from "../core/versions.ts";
import { record } from "../shared/values.ts";

export function packageInfo() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const packageJson = record(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as unknown);
    return { ...contractMetadata(), name: typeof packageJson.name === "string" ? packageJson.name : "opencode-chromium", version: typeof packageJson.version === "string" ? packageJson.version : PLUGIN_VERSION, root };
  } catch {
    return { ...contractMetadata(), name: "opencode-chromium", version: PLUGIN_VERSION, root };
  }
}
