-- Quest Log Cloudflare persistence foundation.
-- Bridge mode continues using the self-hosted JSON database.
-- A later migration stage will move this shared state shape into D1.

CREATE TABLE IF NOT EXISTS questlog_state (
  user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questlog_state_updated_at
  ON questlog_state(updated_at);
