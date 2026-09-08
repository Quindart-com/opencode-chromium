import { z } from "zod";
import { integerField, type Database, type SqlValue } from "./database.ts";

const scopeSchema = z.object({
  profileIds: z.array(z.string().min(1).max(160)).max(50).nullable().optional(),
  includeUnattributed: z.boolean().optional(),
});
export type StatisticsScope = z.infer<typeof scopeSchema>;
export const profileSchema = z.object({
  profileId: z.string().min(1).max(160),
  profileLabel: z.string().max(80).nullable().optional(),
  browserName: z.string().max(80).nullable().optional(),
});
export type MemoryProfile = z.infer<typeof profileSchema>;

export class ProfileStatistics {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  register(input: MemoryProfile): void {
    const profile = profileSchema.parse(input);
    this.db.prepare("INSERT INTO memory_profiles (profile_id, label, browser_name) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET label = excluded.label, browser_name = excluded.browser_name")
      .run(profile.profileId, profile.profileLabel ?? null, profile.browserName ?? null);
  }

  list(): MemoryProfile[] {
    return this.db.prepare("SELECT profile_id AS profileId, label AS profileLabel, browser_name AS browserName FROM memory_profiles ORDER BY COALESCE(label, browser_name, profile_id), profile_id")
      .all().map((row) => profileSchema.parse(row));
  }

  inheritChain(target: number, sources: number[]): void {
    for (const source of sources) this.db.prepare("INSERT OR IGNORE INTO memory_chain_profiles (item_id, profile_id) SELECT ?, profile_id FROM memory_chain_profiles WHERE item_id = ?").run(target, source);
  }

  negativeActions(scope: StatisticsScope): number {
    const filter = this.filter("event", scope, "memory_usage_events.id");
    return integerField(this.db.prepare(`SELECT COUNT(DISTINCT action_id) AS n FROM memory_usage_events WHERE event_type = 'action_recorded' AND success = 0 AND action_id IN (SELECT id FROM memory_actions_v2) AND ${filter.sql}`).get(...filter.params), "n");
  }

  attribute(kind: "action" | "chain" | "event", id: number | bigint, profileId: string | null): void {
    if (!profileId) return;
    this.db.prepare("INSERT INTO memory_profiles (profile_id) VALUES (?) ON CONFLICT DO NOTHING").run(profileId);
    const table = { action: "memory_action_profiles", chain: "memory_chain_profiles", event: "memory_event_profiles" }[kind];
    this.db.prepare(`INSERT INTO ${table} (item_id, profile_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(id, profileId);
  }

  filter(kind: "action" | "chain" | "event", scope: StatisticsScope = {}, id = "id"): { sql: string; params: SqlValue[] } {
    const parsed = scopeSchema.parse(scope);
    if (parsed.profileIds == null) return { sql: "1 = 1", params: [] };
    const profileIds = [...new Set(parsed.profileIds)];
    const table = { action: "memory_action_profiles", chain: "memory_chain_profiles", event: "memory_event_profiles" }[kind];
    const selected = profileIds.length ? `EXISTS (SELECT 1 FROM ${table} p WHERE p.item_id = ${id} AND p.profile_id IN (${profileIds.map(() => "?").join(",")}))` : "0 = 1";
    const unknown = parsed.includeUnattributed ? ` OR NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.item_id = ${id})` : "";
    return { sql: `(${selected}${unknown})`, params: profileIds };
  }

  count(kind: "action" | "chain" | "event", scope: StatisticsScope, condition = "1 = 1", params: SqlValue[] = []): number {
    const table = { action: "memory_actions_v2", chain: "memory_chains_v2", event: "memory_usage_events" }[kind];
    const filter = this.filter(kind, scope, `${table}.id`);
    return integerField(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE (${condition}) AND ${filter.sql}`).get(...params, ...filter.params), "n");
  }
}
