CREATE TABLE IF NOT EXISTS questlog_integration_preferences(
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  earn_xp INTEGER NOT NULL DEFAULT 1,
  challenge_eligible INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private',
  enabled INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id,provider_id)
);

CREATE TABLE IF NOT EXISTS questlog_progress_events(
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  verification TEXT NOT NULL DEFAULT 'provider',
  visibility TEXT NOT NULL DEFAULT 'private',
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id,provider_id,source_event_id)
);

CREATE TABLE IF NOT EXISTS questlog_progress_profiles(
  user_id TEXT PRIMARY KEY,
  total_xp INTEGER NOT NULL DEFAULT 0,
  fitness_xp INTEGER NOT NULL DEFAULT 0,
  health_xp INTEGER NOT NULL DEFAULT 0,
  productivity_xp INTEGER NOT NULL DEFAULT 0,
  focus_xp INTEGER NOT NULL DEFAULT 0,
  development_xp INTEGER NOT NULL DEFAULT 0,
  wellbeing_xp INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_events_user_date
  ON questlog_progress_events(user_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_events_user_category
  ON questlog_progress_events(user_id,category,occurred_at DESC);
