CREATE TABLE IF NOT EXISTS testflight_public_rollouts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  build_run_id TEXT NOT NULL,
  ci_build_number TEXT NOT NULL,
  asc_build_id TEXT,
  workflow_name TEXT NOT NULL,
  tag_name TEXT,
  app_name TEXT NOT NULL,
  notes TEXT,
  release_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  target_groups_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  telegram_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_testflight_public_rollouts_due
ON testflight_public_rollouts(status, due_at);

CREATE INDEX IF NOT EXISTS idx_testflight_public_rollouts_build_run
ON testflight_public_rollouts(build_run_id);
