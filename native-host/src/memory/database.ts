export type SqlValue = string | number | bigint | Uint8Array | null;

export interface Statement {
  run(...parameters: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...parameters: SqlValue[]): unknown;
  all(...parameters: SqlValue[]): unknown[];
}

export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}

export function integerField(value: unknown, key: string): number {
  if (value === null || typeof value !== "object" || !(key in value)) throw new Error(`Missing database field: ${key}`);
  const field = Reflect.get(value, key);
  if (typeof field !== "number" && typeof field !== "bigint" && field !== null) throw new Error(`Invalid database field: ${key}`);
  const number = Number(field ?? 0);
  if (!Number.isSafeInteger(number)) throw new Error(`Database count is out of range: ${key}`);
  return number;
}
