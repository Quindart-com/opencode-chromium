import fs from "node:fs";
import path from "node:path";

export function extensionDisplayName(manifest, directory) {
  if (manifest.name !== "__MSG_extensionName__") return manifest.name;
  if (manifest.default_locale !== "en") return null;
  try { return JSON.parse(fs.readFileSync(path.join(directory, "_locales/en/messages.json"), "utf8")).extensionName?.message; }
  catch { return null; }
}
