CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oidc_states_expires ON oidc_states(expires_at);
