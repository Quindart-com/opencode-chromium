import { execFileSync } from "node:child_process";

// Windows protects the key with the current user's DPAPI identity. POSIX uses
// the native-host's owner-only state directory and credential file permissions.
function dpapi(value: string, decrypt: boolean): string {
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value, encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
export function protectKey(key: string): string {
  return process.platform === "win32" ? `dpapi:${dpapi(Buffer.from(key).toString("base64"), false)}` : key;
}
const cache = new Map<string, string>();
const FAILURE_CACHE_MS = 60_000;
const failures = new Map<string, { error: Error; until: number }>();
export function resetCredentialCache(): void { cache.clear(); failures.clear(); }
export function revealKey(value: string): string {
  if (!value.startsWith("dpapi:")) return value;
  if (process.platform !== "win32") throw new Error("Credential belongs to another operating system");
  const found = cache.get(value);
  if (found) return found;
  const failure = failures.get(value);
  if (failure && failure.until > Date.now()) throw failure.error;
  failures.delete(value);
  let key: string;
  try { key = Buffer.from(dpapi(value.slice(6), true), "base64").toString("utf8"); }
  catch (error) {
    // Do not respawn PowerShell on every call while decryption keeps failing.
    const cached = error instanceof Error ? error : new Error(String(error));
    failures.clear(); failures.set(value, { error: cached, until: Date.now() + FAILURE_CACHE_MS });
    throw cached;
  }
  cache.clear(); failures.clear(); cache.set(value, key);
  return key;
}
