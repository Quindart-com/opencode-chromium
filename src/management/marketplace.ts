import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parse } from "smol-toml";
import { record } from "../shared/values.ts";
import { atomicJson } from "../../native-host/src/runtime-participants.ts";

function upgrade(home: string): Promise<boolean> {
  const args = ["plugin", "marketplace", "upgrade", "quindart-browser"];
  return new Promise(resolve => execFile(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex",
    process.platform === "win32" ? ["/d", "/s", "/c", "codex " + args.join(" ")] : args,
    { windowsHide: true, timeout: 15000, maxBuffer: 16384, env: { ...process.env, CODEX_HOME: home } }, error => resolve(!error)));
}

/** Use Codex's supported Git refresh; never edit its snapshot or installed-plugin cache. */
export async function refreshBrowserMarketplace({ version, dir, home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), run = upgrade }: { version: string; dir: string; home?: string; run?: typeof upgrade }) {
  let enabled = false;
  try {
    const config = record(parse(fs.readFileSync(path.join(home, "config.toml"), "utf8")));
    enabled = record(record(config.plugins)["opencode-browser-plugin@quindart-browser"]).enabled === true;
  }
  catch { /* A missing or invalid configuration is owned by Codex. */ }
  if (!enabled) return { status: "not_configured" };
  const marker = path.join(dir, "codex-marketplace-refresh.json"), lock = marker + ".lock";
  try { if (record(JSON.parse(fs.readFileSync(marker, "utf8"))).version === version) return { status: "current" }; } catch { /* First refresh. */ }
  fs.mkdirSync(dir, { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.unlinkSync(lock); } catch { /* No expired lock. */ }
  let handle: number;
  try { handle = fs.openSync(lock, "wx"); } catch { return { status: "pending" }; }
  try {
    const ok = await run(home);
    if (ok) atomicJson(marker, { version });
    return { status: ok ? "refreshed" : "manual", command: "codex plugin marketplace upgrade quindart-browser" };
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
