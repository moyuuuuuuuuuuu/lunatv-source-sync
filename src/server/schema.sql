CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  api TEXT NOT NULL,
  detail TEXT,
  comment TEXT,
  classification_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (classification_mode IN ('auto', 'adult', 'normal')),
  is_adult INTEGER NOT NULL DEFAULT 0 CHECK (is_adult IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  ignore_health_check INTEGER NOT NULL DEFAULT 0 CHECK (ignore_health_check IN (0, 1)),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_checked_at TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sources_enabled_adult_idx
  ON sources (enabled, is_adult);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS health_checks_source_checked_idx
  ON health_checks (source_id, checked_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS health_checks_limit_per_source
AFTER INSERT ON health_checks
BEGIN
  DELETE FROM health_checks
  WHERE source_id = NEW.source_id
    AND id NOT IN (
      SELECT id FROM health_checks
      WHERE source_id = NEW.source_id
      ORDER BY checked_at DESC, id DESC
      LIMIT 30
    );
END;

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES
  ('check_interval_hours', '24'),
  ('request_timeout_ms', '10000'),
  ('failure_threshold', '3'),
  ('cache_time', '7200'),
  ('next_check_at', ''),
  ('subscription_token', '');

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
