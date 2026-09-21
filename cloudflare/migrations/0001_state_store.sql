-- Quest Log standalone Cloudflare state store.
-- Cloud and self-hosted deployments use separate persistence.
-- The Cloudflare runtime stores its workspace in D1; CasaOS continues using /data/countdown-data.json.

CREATE TABLE IF NOT EXISTS questlog_state (
  workspace_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questlog_state_updated_at
  ON questlog_state(updated_at);
