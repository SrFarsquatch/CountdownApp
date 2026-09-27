CREATE TABLE IF NOT EXISTS questlog_challenges(
  challenge_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rule_json TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questlog_challenge_participants(
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(challenge_id,user_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_participant_user
  ON questlog_challenge_participants(user_id,joined_at DESC);
