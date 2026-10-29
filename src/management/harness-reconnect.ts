import fs from "node:fs";
import path from "node:path";
import { harnessControls,refreshHarnessControl } from "../../native-host/src/harness-control.ts";
import { runProcess } from "../../native-host/src/process-effect.ts";
import { detectHarnesses,planHarness,type Harness } from "./harnesses.ts";
import { applyTransaction } from "./transaction.ts";

export const reconnectTargets = ["codex", "opencode", "dsh"] as const;
export type ReconnectTarget = typeof reconnectTargets[number];
function command(harness: Harness) {
  if (!harness.executable) return null;
  if (!/\.(cmd|ps1)$/i.test(harness.executable)) return { executable: harness.executable, args: [] as string[] };
  const packages = harness.id === "opencode" ? ["@opencode/cli", "opencode-ai"] : harness.id === "codex" ? ["@openai/codex"] : [];
  for (const name of packages) {
    const root = path.join(path.dirname(harness.executable), "node_modules", name);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { bin: string | Record<string, string> };
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[harness.id];
      if (!bin) continue;
      const entry = path.resolve(root, bin);
      if (entry.startsWith(path.resolve(root) + path.sep) && fs.existsSync(entry)) return { executable: process.execPath, args: [entry] };
    } catch { /* Try the supported legacy package. */ }
  }
  return null;
}
export async function reconnectHarness(target: unknown, dir: string, {
  controls = harnessControls, refresh = refreshHarnessControl, detect = detectHarnesses, run = runProcess,
}: { controls?: typeof harnessControls; refresh?: typeof refreshHarnessControl; detect?: typeof detectHarnesses; run?: typeof runProcess } = {}) {
  if (!reconnectTargets.includes(target as ReconnectTarget)) throw new Error("Unknown harness");
  const links = controls(dir).filter(row => row.harness === target);
  if (links.length) {
    const results = await Promise.all(links.map(row => refresh(row)));
    const refreshed = results.filter(row => row.ok).length;
    return { ok: refreshed > 0, code: results.some(row => row.code === "busy") ? "busy" : refreshed ? "refreshed" : "unreachable", refreshed };
  }
  const harness = detect().find(row => row.id === target);
  if (!harness?.detected) return { ok: false, code: "not_installed", refreshed: 0 };
  if (!harness.managed) applyTransaction([planHarness(harness, dir)]);
  const cli = command(harness);
  if (cli && target === "opencode") {
    await run(cli.executable, [...cli.args, "reload"], { cwd: path.dirname(harness.configPath), timeoutMs: 15000 });
  } else if (cli && target === "codex") {
    await run(cli.executable, [...cli.args, "plugin", "add", "opencode-browser-plugin@quindart-browser"], { cwd: path.dirname(harness.configPath), timeoutMs: 30000 });
  } else if (target === "dsh" && fs.existsSync(harness.configPath)) {
    // The profile loader watches this file. The user configuration and other
    // plugin entries are retained; no harness or process is restarted.
    const now = new Date(); fs.utimesSync(harness.configPath, now, now);
  }
  // A CLI exit is not evidence that a model has received tools. The panel
  // stays disconnected until a live browser heartbeat independently arrives.
  return { ok: true, code: "waiting_for_harness", refreshed: 0 };
}
