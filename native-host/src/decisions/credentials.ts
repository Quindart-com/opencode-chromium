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
export function revealKey(value: string): string {
  if (!value.startsWith("dpapi:")) return value;
  if (process.platform !== "win32") throw new Error("Credential belongs to another operating system");
  const found = cache.get(value);
  if (found) return found;
  const key = Buffer.from(dpapi(value.slice(6), true), "base64").toString("utf8");
  cache.clear(); cache.set(value, key);
  return key;
}
