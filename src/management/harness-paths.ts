import os from "node:os";
import path from "node:path";
import { harnessEnv,type HarnessId } from "../shared/harnesses.ts";

/** Standard config locations, respecting each harness's environment overrides. */
export function harnessConfigPath(client: HarnessId, home = os.homedir()) {
  const target = client === "opencode-mcp" ? "opencode" : client;
  const override = process.env[harnessEnv(target, "CONFIG")];
  if (override) return path.resolve(override);
  if (target === "opencode" && process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG);
  if (client === "dsh") return path.join(process.env.DSH_HOME ?? path.join(home, ".dsh"), "profiles", "web", "cordis.patch.yml");
  if (client === "claude-code") return path.join(process.env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
  if (client === "claude-desktop") return path.join(process.platform === "win32" ? process.env.APPDATA ?? path.join(home, "AppData", "Roaming") : path.join(home, "Library", "Application Support"), "Claude", "claude_desktop_config.json");
  if (client === "codex") return path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode", "opencode.json");
}
