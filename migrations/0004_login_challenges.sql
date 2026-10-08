CREATE TABLE IF NOT EXISTS login_challenges (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_expires ON login_challenges(expires_at);
