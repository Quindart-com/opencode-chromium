export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id               INTEGER PRIMARY KEY,
  fingerprint      TEXT NOT NULL UNIQUE,
  signature        TEXT NOT NULL,
  capability       TEXT NOT NULL,
  hostname         TEXT,
  verb             TEXT NOT NULL,
  label            TEXT,
  embedding        BLOB,
  model_id         TEXT,
  confirmed_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  source_session   TEXT,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signatures_model ON signatures(model_id);
CREATE INDEX IF NOT EXISTS idx_signatures_seen ON signatures(last_seen);
CREATE INDEX IF NOT EXISTS idx_signatures_cap ON signatures(capability);

CREATE TABLE IF NOT EXISTS failure_contexts (
  id            INTEGER PRIMARY KEY,
  signature_id  INTEGER NOT NULL REFERENCES signatures(id) ON DELETE CASCADE,
  error_code    TEXT NOT NULL,
  step_index    INTEGER,
  chain_id      INTEGER,
  count         INTEGER NOT NULL DEFAULT 1,
  occurred_at   TEXT NOT NULL,
  last_hit_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_failure_sig ON failure_contexts(signature_id);
CREATE INDEX IF NOT EXISTS idx_failure_occurred ON failure_contexts(occurred_at);

CREATE TABLE IF NOT EXISTS chains (
  id               INTEGER PRIMARY KEY,
  fingerprint      TEXT NOT NULL UNIQUE,
  intent           TEXT,
  embedding        BLOB,
  model_id         TEXT,
  steps_json       TEXT NOT NULL,
  confirmed_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  source_sessions  TEXT,
  merged_of        TEXT,
  replaced_by      INTEGER,
  supersedes       INTEGER,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chains_head ON chains(replaced_by);
CREATE INDEX IF NOT EXISTS idx_chains_model ON chains(model_id);
`;

export function stepFingerprint(chainId, position) {
  return `${chainId}:${position}`;
}