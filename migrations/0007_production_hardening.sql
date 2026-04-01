-- ============================================================
-- Migration 0007: Production Hardening
-- Covers: async queue tracking, CF Pages deploy fields,
--         2FA, API keys, file uploads schema, versioning,
--         planning tasks, indexes, archive cascade triggers,
--         idempotency keys
-- ============================================================

-- ── Build Jobs: queue_message_id for CF Queues tracking ──────────────────────
ALTER TABLE build_jobs ADD COLUMN queue_message_id TEXT;
ALTER TABLE build_jobs ADD COLUMN worker_started_at DATETIME;

-- ── Deployments: real CF Pages fields (only add missing columns) ──────────────
ALTER TABLE deployments ADD COLUMN cf_deployment_id TEXT;
ALTER TABLE deployments ADD COLUMN cf_pages_project TEXT;
ALTER TABLE deployments ADD COLUMN cf_upload_token TEXT;
ALTER TABLE deployments ADD COLUMN build_artifact_key TEXT;
-- Note: last_health_check already exists from migration 0006

-- ── Users: 2FA columns (map to existing two_factor_* columns) ────────────────
-- two_factor_enabled and two_factor_secret already exist; add backup codes only
ALTER TABLE users ADD COLUMN totp_backup_codes TEXT; -- JSON array of hashed codes

-- ── API Keys table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix    TEXT NOT NULL,           -- e.g. "dpk_live_abc12345" (shown to user)
  key_hash      TEXT NOT NULL UNIQUE,    -- SHA-256 of full key (never stored plain)
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '["build:read","build:write"]',
  last_used_at  DATETIME,
  last_used_ip  TEXT,
  expires_at    DATETIME,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_api_keys_user  ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash  ON api_keys(key_hash);

-- ── Uploaded Files (recreate with full schema if not yet created) ─────────────
CREATE TABLE IF NOT EXISTS uploaded_files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  r2_key        TEXT NOT NULL UNIQUE,
  file_name     TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  is_public     INTEGER NOT NULL DEFAULT 0,
  public_url    TEXT,
  metadata      TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_user    ON uploaded_files(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_project ON uploaded_files(project_id);

-- ── Transform Outputs (Spec Transformer persistence) ─────────────────────────
CREATE TABLE IF NOT EXISTS transform_outputs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_spec_id  TEXT,
  transform_type  TEXT NOT NULL DEFAULT 'standard',
  output_content  TEXT NOT NULL,
  tokens_used     INTEGER DEFAULT 0,
  coins_charged   INTEGER DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_transform_project ON transform_outputs(project_id);

-- ── Planning Tasks ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  column_id   TEXT NOT NULL DEFAULT 'todo',  -- todo | in_progress | done
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT NOT NULL DEFAULT 'medium',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  due_date    DATE,
  tags        TEXT,                           -- JSON array
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_planning_tasks_user    ON planning_tasks(user_id);
CREATE INDEX idx_planning_tasks_project ON planning_tasks(project_id);

-- ── Idempotency Keys (prevent double-spend on retries) ───────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  response     TEXT NOT NULL,            -- cached JSON response
  status_code  INTEGER NOT NULL DEFAULT 200,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL
);
CREATE INDEX idx_idempotency_user    ON idempotency_keys(user_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ── Missing indexes on hot paths ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_build_jobs_status      ON build_jobs(status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_user_status ON build_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_project     ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_user        ON intent_log(user_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_project     ON intent_log(project_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_status      ON intent_log(status);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user       ON coin_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_created    ON coin_ledger_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user     ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_projects_user_status   ON projects(user_id, status);
CREATE INDEX IF NOT EXISTS idx_deployments_user       ON deployments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_window ON rate_limits(key, window_start);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user        ON audit_logs(user_id, created_at);

-- ── Archive Cascade Trigger: release coin holds when project archived ─────────
CREATE TRIGGER IF NOT EXISTS trg_archive_cascade
AFTER UPDATE ON projects
WHEN NEW.status = 'archived' AND OLD.status != 'archived'
BEGIN
  -- Release any active coin holds for this project's jobs
  UPDATE coin_holds
  SET    status = 'released', released_at = CURRENT_TIMESTAMP
  WHERE  reference_id IN (
           SELECT id FROM build_jobs WHERE project_id = NEW.id
         )
  AND    status = 'active';

  -- Return held coins to wallet
  UPDATE coin_wallets
  SET    balance = balance + COALESCE((
           SELECT SUM(ch.amount)
           FROM   coin_holds ch
           JOIN   build_jobs bj ON ch.reference_id = bj.id
           WHERE  bj.project_id = NEW.id
           AND    ch.status = 'released'
           AND    ch.released_at >= CURRENT_TIMESTAMP
         ), 0),
         updated_at = CURRENT_TIMESTAMP
  WHERE  user_id = NEW.user_id;

  -- Fail any queued/processing jobs
  UPDATE build_jobs
  SET    status = 'failed',
         error_message = 'Project archived',
         completed_at = CURRENT_TIMESTAMP
  WHERE  project_id = NEW.id
  AND    status IN ('queued', 'processing');
END;

-- ── Project Version on Build Completion Trigger ───────────────────────────────
CREATE TRIGGER IF NOT EXISTS trg_project_version_on_build
AFTER UPDATE ON build_jobs
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
  INSERT OR IGNORE INTO project_versions (
    id, project_id, version_number, build_job_id, created_by,
    change_summary, created_at
  )
  SELECT
    'pv_' || hex(randomblob(6)),
    NEW.project_id,
    COALESCE((SELECT MAX(version_number) FROM project_versions WHERE project_id = NEW.project_id), 0) + 1,
    NEW.id,
    NEW.user_id,
    COALESCE(NEW.result_summary, 'Build completed'),
    CURRENT_TIMESTAMP;
END;
