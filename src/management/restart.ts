import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";

type DesktopApp = "Codex" | "Claude";
function command(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  return { ok: result.status === 0, output: result.stdout?.trim() ?? "" };
}
export function runningDesktopApps(): DesktopApp[] {
  if (process.platform === "win32") {
    const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process -Name Codex,Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty ProcessName"]);
    return (["Codex", "Claude"] as const).filter(name => result.output.split(/\r?\n/).some(line => line.toLowerCase() === name.toLowerCase()));
  }
  if (process.platform === "darwin") {
    const result = command("ps", ["-axo", "comm="]);
    return (["Codex", "Claude"] as const).filter(name => result.output.includes(`/Applications/${name}.app/Contents/`));
  }
  return [];
}
export function restartDesktop(app: DesktopApp) {
  if (process.platform === "win32") {
    const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$taskApp = Get-Process -Name '${app}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if (-not $taskApp) { exit 0 }; $taskAppPath = $taskApp.Path; if (-not $taskApp.CloseMainWindow()) { exit 2 }; if (-not $taskApp.WaitForExit(10000)) { exit 3 }; Start-Process -FilePath $taskAppPath`]);
    return { app, restarted: result.ok, reason: result.ok ? null : "App declined graceful quit; restart it manually" };
  }
  if (process.platform === "darwin") {
    const quit = command("osascript", ["-e", `tell application "${app}" to quit`]);
    const stillRunning = runningDesktopApps().includes(app);
    const opened = quit.ok && !stillRunning && command("open", ["-a", `/Applications/${app}.app`]).ok;
    return { app, restarted: Boolean(opened), reason: opened ? null : "App declined graceful quit; restart it manually" };
  }
  return { app, restarted: false, reason: "Automatic desktop restart unsupported on this platform" };
}
export async function offerRestart(targets: string[], explicit = false, interactive = true) {
  const running = runningDesktopApps().filter(app => app === "Codex" ? targets.includes("codex") : targets.includes("claude-desktop"));
  if (!running.length) return [];
  let approved = explicit;
  if (!approved && interactive && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { approved = /^(y|yes)$/i.test((await prompt.question(`Configuration saved. Restart ${running.join(", ")} gracefully now? [y/N] `)).trim()); }
    finally { prompt.close(); }
  }
  return running.map(app => approved ? restartDesktop(app) : { app, restarted: false, reason: "Pending user restart" });
}
