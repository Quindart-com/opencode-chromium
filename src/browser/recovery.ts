import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { record } from "../shared/values.ts";

export const RECOVERY_COMMAND = "opencode-chromium doctor --repair-runtime --connection-only --json";
export function transportFailure(error: unknown): boolean {
  return error instanceof Error && /Timed out waiting for (?:extension|browser host) response|Browser host connection (?:closed|ended)|Could not connect to the agent browser host/.test(error.message);
}
type Report = { attempted: boolean; command: string; healthy: boolean; repaired: number; next: string };
const checks = new Map<string, { at: number; result: Promise<Report> }>();

/** One bounded CLI doctor per profile/cooldown. Never replay a browser mutation. */
export function runRecoveryDoctor(profileId?: string | null): Promise<Report> {
  const key = profileId ?? "default";
  const previous = checks.get(key);
  if (previous && Date.now() - previous.at < 30000) return previous.result;
  const result = new Promise<Report>(resolve => {
    const args = [fileURLToPath(new URL("../cli/index.ts", import.meta.url)), "doctor", "--repair-runtime", "--connection-only", "--json", ...(profileId ? ["--profile", profileId] : [])];
    execFile(process.execPath, args, { windowsHide: true, timeout: 8000, maxBuffer: 16384,
      env: { ...process.env, OPENCODE_BROWSER_SKIP_RECOVERY: "1" } }, (_error, stdout) => {
      let report: Record<string, unknown> = {};
      try { report = record(JSON.parse(stdout)); } catch { /* Failed diagnostics retain the original operation error. */ }
      resolve({ attempted: true, command: RECOVERY_COMMAND, healthy: report.ok === true,
        repaired: typeof report.removed === "number" ? report.removed : 0,
        next: report.ok === true ? "Connection responds. Inspect the original session before retrying an uncertain action." : "Run the doctor command in a permitted local terminal, inspect its checks, repair the identified layer, then verify once. Do not repeat the failed mutation unchanged." });
    });
  });
  if (checks.size >= 32) checks.delete(checks.keys().next().value!);
  checks.set(key, { at: Date.now(), result });
  return result;
}

export function sessionTabs(value: unknown): Record<string, unknown>[] | null {
  const tabs = record(value).tabs;
  return Array.isArray(tabs) && tabs.every(tab => Number.isSafeInteger(record(tab).id)) ? tabs.map(record) : null;
}
export function reconciledTab(before: Record<string, unknown>[], after: Record<string, unknown>[], creationRequestId: string) {
  const ids = new Set(before.map(tab => tab.id));
  const added = after.filter(tab => !ids.has(tab.id));
  const matching = added.filter(tab => tab.creationRequestId === creationRequestId && tab.origin === "agent" && tab.url === "about:blank");
  return matching.length === 1 ? matching[0] : null;
}
