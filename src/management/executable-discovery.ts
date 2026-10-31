import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export function existingFile(file: string | undefined): string | null {
  if (!file) return null;
  try { return fs.statSync(file).isFile() ? path.resolve(file) : null; } catch { return null; }
}
export function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""]) {
      const found = existingFile(path.join(directory.replace(/^"|"$/g, ""), name + suffix)); if (found) return found;
    }
  }
  return null;
}
/** App Paths covers standard/custom Windows installations that are not on PATH. */
export function windowsAppPath(name: string): string | null {
  if (process.platform !== "win32" || !/^[a-z][a-z0-9-]*\.exe$/i.test(name)) return null;
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const output = execFileSync("reg.exe", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`, "/ve"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
      const value = output.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1]?.trim().replace(/^"|"$/g, "");
      const found = existingFile(value?.replace(/%([^%]+)%/g, (_match, key: string) => process.env[key] ?? "%" + key + "%")); if (found) return found;
    } catch { /* Unregistered application or inaccessible hive. */ }
  }
  return null;
}
