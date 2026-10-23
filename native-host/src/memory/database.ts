import { z } from "zod";
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface Statement {
  finalize?(): void;
  run(...parameters: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...parameters: SqlValue[]): unknown;
  all(...parameters: SqlValue[]): unknown[];
}

export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(finalizeStatements?: boolean): void;
}

export function integerField(value: unknown, key: string): number {
  if (value === null || typeof value !== "object" || !(key in value)) throw new Error(`Missing database field: ${key}`);
  const field = Reflect.get(value, key);
  if (typeof field !== "number" && typeof field !== "bigint" && field !== null) throw new Error(`Invalid database field: ${key}`);
  const number = Number(field ?? 0);
  if (!Number.isSafeInteger(number)) throw new Error(`Database count is out of range: ${key}`);
  return number;
}

const rowFields = {
  key: z.string(),
  value: z.string(),
  id: z.number(),
  fingerprint: z.string(),
  signature: z.string(),
  capability: z.string(),
  hostname: z.string().nullable(),
  verb: z.string(),
  label: z.string().nullable(),
  embedding: z.instanceof(Uint8Array).nullable(),
  model_id: z.string().nullable(),
  confirmed_count: z.number(),
  failed_count: z.number(),
  source_session: z.string().nullable(),
  first_seen: z.string(),
  last_seen: z.string(),
  signature_id: z.number(),
  error_code: z.string(),
  step_index: z.number().nullable(),
  chain_id: z.number().nullable(),
  count: z.number(),
  occurred_at: z.string(),
  last_hit_at: z.string().nullable(),
  intent: z.string().nullable(),
  steps_json: z.string(),
  source_sessions: z.string().nullable(),
  merged_of: z.string().nullable(),
  replaced_by: z.number().nullable(),
  supersedes: z.number().nullable(),
  action: z.string(),
  target_label: z.string().nullable(),
  target_role: z.string().nullable(),
  recipe_json: z.string(),
  embedding_profile: z.string().nullable(),
  safe_summary: z.string(),
  event_type: z.string(),
  action_id: z.number().nullable(),
  success: z.number().nullable(),
  duration_ms: z.number().nullable(),
  steps_reused: z.number().nullable().nullable(),
  reason: z.string().nullable(),
  profile_id: z.string(),
  browser_name: z.string().nullable(),
  item_id: z.number(),
  n: z.number(),
  signatures: z.number(),
  chains: z.number(),
  failure_contexts: z.number(),
  confirmed: z.number(),
  failed: z.number(),
  actions_v2: z.number(),
  chains_v2: z.number(),
  executions_v2: z.number(),
  failed_executions_v2: z.number(),
  negative_actions_v2: z.number(),
  usage_events: z.number(),
  search_queries: z.number().nullable(),
  matches_returned: z.number().nullable(),
  replay_attempts: z.number().nullable(),
  replay_successes: z.number().nullable(),
  replay_failures: z.number().nullable(),
  replay_rejections: z.number().nullable(),
  context_count: z.number(),
};
export function sqlProjection<const K extends readonly (keyof typeof rowFields)[]>(...keys: K) {
  const shape = Object.fromEntries(keys.map(key => [key, rowFields[key]])) as Pick<typeof rowFields, K[number]>;
  return z.object(shape);
}
export function prepareRows<T>(db: Database, sql: string, schema: z.ZodType<T>) {
  const statement = db.prepare(sql);
  const get = (...parameters: SqlValue[]): T | undefined => {
    const row = statement.get(...parameters);
    return row === undefined || row === null ? undefined : schema.parse(row);
  };
  return { run: statement.run.bind(statement), get,
    requiredGet(...parameters: SqlValue[]): T { const row = get(...parameters); if (!row) throw new Error("Expected database row was not found"); return row; },
    all: (...parameters: SqlValue[]): T[] => statement.all(...parameters).map(row => schema.parse(row)),
  };
}

/** Cache compiled SQL with bounded ownership; finalize all statements before closing. */
export function managedDatabase(driver: Database, capacity = 64): Database {
  const statements = new Map<string, Statement>();
  let closed = false;
  const statement = (sql: string): Statement => {
    if (closed) throw new Error("Database has closed");
    let value = statements.get(sql);
    if (value) statements.delete(sql);
    else value = driver.prepare(sql);
    statements.set(sql, value);
    while (statements.size > capacity) {
      const first = statements.entries().next();
      if (first.done) break;
      statements.delete(first.value[0]);
      first.value[1].finalize?.();
    }
    return value;
  };
  return {
    exec(sql) { if (closed) throw new Error("Database has closed"); return driver.exec(sql); },
    prepare(sql) { return { run: (...p) => statement(sql).run(...p), get: (...p) => statement(sql).get(...p), all: (...p) => statement(sql).all(...p) }; },
    close() { if (closed) return; closed = true; try { for (const value of statements.values()) value.finalize?.(); } finally { statements.clear(); driver.close(); } },
  };
}
