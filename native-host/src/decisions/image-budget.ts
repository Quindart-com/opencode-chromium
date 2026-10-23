import fs from "node:fs";
import path from "node:path";
import { providerSettingsPath } from "./settings.js";

export const DAILY_IMAGE_LIMIT = 20;
export function imageRequestAvailable(now = Date.now()): boolean {
  const directory = budgetDirectory(now);
  try {
    return !fs.existsSync(path.join(directory, `minute-${Math.floor(now / 60_000)}`)) &&
      fs.readdirSync(directory).filter(name => /^request-\d+$/.test(name)).length < DAILY_IMAGE_LIMIT;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
const budgetDirectory = (now: number) => path.join(path.dirname(providerSettingsPath()), "image-budget", new Date(now).toISOString().slice(0, 10));
// Reservations survive host restarts and are shared by profiles. Failed and
// cancelled requests consume a slot too: cancellation does not promise a refund.
export function reserveImageRequest(now = Date.now()): boolean {
  const directory = budgetDirectory(now);
  if (!imageRequestAvailable(now)) return false;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    pruneOldReservations(path.dirname(directory), now);
    const minute = path.join(directory, `minute-${Math.floor(now / 60_000)}`);
    fs.closeSync(fs.openSync(minute, "wx", 0o600));
    for (let slot = 0; slot < DAILY_IMAGE_LIMIT; slot++) {
      try {
        fs.closeSync(fs.openSync(path.join(directory, `request-${slot}`), "wx", 0o600));
        return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; }
    }
  } catch { /* A busy or unwritable budget fails closed, without a paid call. */ }
  return false;
}

function pruneOldReservations(root: string, now: number): void {
  const cutoff = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
  try {
    for (const day of fs.readdirSync(root).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff).slice(0, 8)) {
      const directory = path.join(root, day);
      if (fs.lstatSync(directory).isSymbolicLink()) continue;
      for (const file of fs.readdirSync(directory)) {
        if (/^(?:minute|request)-\d+$/.test(file)) fs.unlinkSync(path.join(directory, file));
      }
      fs.rmdirSync(directory);
    }
  } catch { /* Housekeeping must not weaken the current day's reservation. */ }
}
