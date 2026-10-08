CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings (key, value, updated_at)
VALUES ('access_everyone', '1', datetime('now'))
ON CONFLICT(key) DO NOTHING;

INSERT INTO app_settings (key, value, updated_at)
VALUES ('allowed_users', '[]', datetime('now'))
ON CONFLICT(key) DO NOTHING;
