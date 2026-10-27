import fs from "node:fs";
import path from "node:path";
import { record } from "../shared/values.ts";

export const CODEX_MARKETPLACE_UPDATE = "codex plugin marketplace upgrade quindart-browser";

/** Inspect the nearest project catalog without changing Codex's configuration or cache. */
export function inspectProjectBrowserPlugin(version: string, directory = process.cwd()) {
  let root = path.resolve(directory);
  for (;;) {
    const catalogPath = path.join(root, ".agents", "plugins", "marketplace.json");
    if (fs.existsSync(catalogPath)) {
      try {
        const catalog = record(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
        const entries = Array.isArray(catalog.plugins) ? catalog.plugins : [];
        const entry = entries.map(record).find(item => item.name === "opencode-browser-plugin");
        if (!entry) return null;
        const source = record(entry.source);
        const relative = typeof entry.source === "string" ? entry.source : source.source === "local" ? source.path : null;
        if (typeof relative !== "string") return null;
        const manifestPath = path.resolve(root, relative, ".codex-plugin", "plugin.json");
        const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
        if (manifest.name !== "opencode-browser-plugin" || typeof manifest.version !== "string") return null;
        return {
          ok: manifest.version === version,
          marketplace: catalog.name,
          manifestPath,
          pluginVersion: manifest.version,
          runtimeVersion: version,
          message: manifest.version === version ? "Project plugin listing matches this CLI." :
            "This project exposes a different plugin version in Codex. Updating npm does not update the project catalog. Use the upstream marketplace for releases, or keep this checkout as a deliberate development source.",
          updateCommand: CODEX_MARKETPLACE_UPDATE,
        };
      } catch { return null; /* A malformed project catalog is owned by Codex, not this CLI. */ }
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
