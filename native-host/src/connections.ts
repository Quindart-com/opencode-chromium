import { randomUUID } from "node:crypto";
import { harnessLabels,safeClientVersion,type ClientIdentity,type ConnectionSnapshot,type HarnessConnection } from "../../src/shared/connections.ts";
import { record } from "../../src/shared/values.ts";

export class HarnessConnections<T> {
  readonly #rows = new Map<T, HarnessConnection>();
  readonly #now: typeof Date.now;
  constructor(now = Date.now) { this.#now = now; }
  touch(socket: T, client: unknown, runtimeVersion: unknown, pending: number, action: boolean) {
    const data = record(client), existing = this.#rows.get(socket), time = this.#now();
    const harness = typeof data.harness === "string" && Object.hasOwn(harnessLabels, data.harness) ? data.harness as ClientIdentity["harness"] : "mcp";
    const identified = ["mcp", "plugin", "sdk"].includes(String(data.transport)) && Number.isSafeInteger(data.pid) && Number(data.pid) > 0;
    this.#rows.set(socket, { id: existing?.id ?? randomUUID(), harness, harnessVersion: safeClientVersion(data.harnessVersion),
      transport: identified ? data.transport as ClientIdentity["transport"] : "mcp", pid: identified ? Number(data.pid) : 0,
      phase: existing?.phase === "used" || data.phase === "used" || action ? "used" : "initialized", runtimeVersion: safeClientVersion(runtimeVersion),
      connectedAt: existing?.connectedAt ?? time, lastSeenAt: time, lastActionAt: action ? time : existing?.lastActionAt ?? null,
      pending, state: identified ? "responding" : "unidentified" });
  }
  remove(socket: T) { this.#rows.delete(socket); }
  find(id: unknown) { return [...this.#rows].find(([, row]) => row.id === id)?.[0]; }
  snapshot(version: string | undefined, pending: (socket: T) => number): ConnectionSnapshot {
    const observedAt = this.#now();
    return { observedAt, host: { version: version ?? null, pid: process.pid }, clients: [...this.#rows].slice(0, 100).map(([socket, row]) => ({
      ...row, pending: pending(socket), state: row.state === "unidentified" ? "unidentified" : observedAt - row.lastSeenAt > 45000 ? "stale" : "responding",
    })) };
  }
}
