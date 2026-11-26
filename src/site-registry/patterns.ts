// This vocabulary is the complete wire format for background contributions.
import { fieldsForTask, taskFields } from "./intent.ts";
import { packageField, packageResource } from "./package-read.ts";
export const patternSites = ["hacker-news", "npm"] as const;
export type PatternSite = typeof patternSites[number];
export const weekMs = 7 * 86400000;
export const patternWindow = (now: number) => Math.floor(now / weekMs);
export function validPattern(site: unknown, task: unknown): task is string {
  if (typeof task !== "string" || !task || task.length > 48) return false;
  if (site === "npm") return task === "version" || task === "license";
  if (site !== "hacker-news") return false;
  return taskFields.filter(field => task.split("+").includes(field)).join("+") === task;
}

// Raw URLs and labels are consumed on device. Private scopes, tenant names,
// extra URL parameters and arbitrary public package names are ineligible.
export function patternForPage(url: string, label: string) {
  if (/^https:\/\/news\.ycombinator\.com\/item\?id=[1-9]\d{0,9}$/.test(url)) {
    const task = fieldsForTask(label).join("+");
    if (validPattern("hacker-news", task)) return { site: "hacker-news" as const, task };
  }
  if (packageResource(url)) {
    const task = packageField(label);
    if (validPattern("npm", task)) return { site: "npm" as const, task };
  }
  return null;
}
export function validPatternBatch(input: unknown, now: number, withdrawing = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const row = input as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  const current = patternWindow(now);
  if (row.v !== 1 || !patternSites.includes(row.site as PatternSite) ||
      (row.window !== current && row.window !== current - 1)) return false;
  if (withdrawing) return keys === "site,v,window";
  return keys === "site,tasks,v,window" && Array.isArray(row.tasks) && row.tasks.length > 0 &&
    row.tasks.length <= 8 && new Set(row.tasks).size === row.tasks.length &&
    row.tasks.every(task => validPattern(row.site, task));
}
