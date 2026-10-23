import type { runtimeStatus } from "./runtime-link.ts";

export function formatRuntimeStatus(status: ReturnType<typeof runtimeStatus>) {
  const lines = [];
  const mark = (ok: boolean) => ok ? "ok" : "DRIFT";
  lines.push(`runtime dir    ${status.runtimeDir}`);
  lines.push(`linked         ${status.linked ? `ok  ${status.manifest?.root}` : "DRIFT  not linked to this checkout"}`);
  lines.push(`checkout       ${status.branch ?? "?"} @ ${status.revision ?? "?"}${status.dirty ? " (uncommitted changes)" : ""} v${status.version ?? "?"}`);
  lines.push(`bundle         ${status.build.stale ? "DRIFT  stale, run: bun run sync" : `ok  built ${status.build.builtAt ?? "unknown"}`}`);
  const registered = status.registration.filter(entry => entry.registered);
  const stale = registered.filter(entry => !entry.installed).map(entry => entry.browser);
  lines.push(`browser        ${registered.length > 0 ? `ok  ${registered.map(entry => entry.browser).join(", ")}${stale.length > 0 ? ` (${stale.join(", ")} not installed)` : ""}` : "DRIFT  no browser has the native host registered"}`);
  lines.push(`running hosts  ${status.hosts === null ? "unknown (cannot enumerate processes)" : status.hosts.length === 0 ? "none right now (the extension starts one on demand)" : `${status.hosts.length} pid ${status.hosts.map(host => host.pid).join(", ")}`}`);
  for (const skill of status.skills) lines.push(`skill          ${mark(skill.parity)}  ${skill.path}`);
  return lines.join("\n");
}
