CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  class_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_message_id TEXT,
  source_email_date TEXT,
  source_r2_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE(plan_date, version, class_name)
);

CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(plan_date);
CREATE INDEX IF NOT EXISTS idx_plans_date_class ON plans(plan_date, class_name);
