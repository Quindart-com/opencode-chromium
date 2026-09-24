import path from "node:path";
import { packageRoot, updateClientConfig } from "./config.js";
import { installSkills, uninstallSkills } from "./skills.js";

export const SUPPORTED_CLIENTS = ["opencode", "opencode-mcp", "codex", "skills"];

export function installClient({ client, config, dryRun = false, serverPath, pluginPath } = {}) {
  if (!SUPPORTED_CLIENTS.includes(client)) throw new Error(`--client must be ${SUPPORTED_CLIENTS.join(", ")}`);
  if (client === "skills") return installSkills({ dryRun });
  const entry = serverPath ?? path.join(packageRoot(), "dist", "adapters", "mcp", "server.js");
  // `link` registers the stable launcher instead of this checkout, so the
  // entry survives branch switches and version changes.
  const nativeEntry = pluginPath ?? path.join(packageRoot(), "dist", "adapters", "opencode", "index.js");
  return updateClientConfig({ client, filePath: config, serverPath: client === "opencode" ? nativeEntry : entry, action: "install", dryRun });
}

export function uninstallClient({ client, config, dryRun = false } = {}) {
  if (!SUPPORTED_CLIENTS.includes(client)) throw new Error(`--client must be ${SUPPORTED_CLIENTS.join(", ")}`);
  if (client === "skills") return uninstallSkills({ dryRun });
  const nativeEntry = path.join(packageRoot(), "dist", "adapters", "opencode", "index.js");
  return updateClientConfig({ client, filePath: config, action: "uninstall", dryRun, serverPath: client === "opencode" ? nativeEntry : "" });
}

export { packageRoot };