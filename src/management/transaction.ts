import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface FileChange { filePath: string; before: string | null; after: string | null }
export function atomicWrite(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temp, filePath);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function applyTransaction(changes: FileChange[], dryRun = false, afterFiles?: () => void): { changedFiles: string[]; backups: string[] } {
  const selected = changes.filter(change => change.before !== change.after);
  if (new Set(selected.map(change => path.resolve(change.filePath))).size !== selected.length) throw new Error("Duplicate transaction path");
  const completed: FileChange[] = [];
  const backups: string[] = [];
  if (dryRun) return { changedFiles: selected.map(change => change.filePath), backups };
  try {
    for (const change of selected) {
      const current = fs.existsSync(change.filePath) ? fs.readFileSync(change.filePath, "utf8") : null;
      if (current !== change.before) throw new Error(`Configuration changed since planning: ${change.filePath}`);
      if (current !== null) {
        const backup = `${change.filePath}.bak-${randomUUID()}`;
        fs.copyFileSync(change.filePath, backup, fs.constants.COPYFILE_EXCL);
        backups.push(backup);
      }
      if (change.after === null) fs.unlinkSync(change.filePath);
      else atomicWrite(change.filePath, change.after);
      completed.push(change);
    }
    afterFiles?.();
  } catch (cause) {
    const errors: unknown[] = [cause];
    for (const change of completed.reverse()) {
      try {
        if (change.before === null) fs.unlinkSync(change.filePath);
        else atomicWrite(change.filePath, change.before);
      } catch (error) { errors.push(error); }
    }
    throw new AggregateError(errors, errors.length === 1 ? "Configuration transaction rolled back" : "Rollback incomplete; restore from backups", { cause });
  }
  return { changedFiles: selected.map(change => change.filePath), backups };
}
