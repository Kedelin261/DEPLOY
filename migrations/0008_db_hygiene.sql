-- Migration 0008: DB Hygiene — Archive Cascade + Performance Indexes
-- Adds missing indexes to build_jobs and intent_log tables.
-- Adds archive-cascade triggers so archiving a project auto-releases coin holds.
-- Adds api_keys table for Pro/Team public API access.

-- ═══════════════════════════════════════════════════════════════
-- 1. API Keys table (Task 3D)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 hash of the raw key
  key_prefix  TEXT NOT NULL,          -- first 14 chars for display
  is_active   INTEGER NOT NULL DEFAULT 1,
  last_used_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id  ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

-- ═══════════════════════════════════════════════════════════════
-- 2. Performance indexes — build_jobs
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_build_jobs_user_id      ON build_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_project_id   ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status       ON build_jobs(status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_created_at   ON build_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_build_jobs_user_status  ON build_jobs(user_id, status);

-- ═══════════════════════════════════════════════════════════════
-- 3. Performance indexes — intent_log
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_intent_log_user_id    ON intent_log(user_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_project_id ON intent_log(project_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_status     ON intent_log(status);
CREATE INDEX IF NOT EXISTS idx_intent_log_created_at ON intent_log(created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 4. Performance indexes — notifications
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);

-- ═══════════════════════════════════════════════════════════════
-- 5. Performance indexes — coin ledger
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user_id    ON coin_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_ref        ON coin_ledger_entries(reference_type, reference_id);

-- ═══════════════════════════════════════════════════════════════
-- 6. Performance indexes — deployments
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_deployments_user_id    ON deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status     ON deployments(status);

-- ═══════════════════════════════════════════════════════════════
-- 7. Archive Cascade Trigger
--    When a project is archived, automatically release any active
--    coin holds tied to its build jobs (prevents coins being locked forever).
-- ═══════════════════════════════════════════════════════════════
CREATE TRIGGER IF NOT EXISTS trg_project_archive_release_holds
AFTER UPDATE OF status ON projects
WHEN NEW.status = 'archived' AND OLD.status != 'archived'
BEGIN
  -- Release coin holds for all pending/processing build jobs of this project
  UPDATE coin_holds
  SET status = 'released',
      released_at = CURRENT_TIMESTAMP
  WHERE id IN (
    SELECT coin_hold_id FROM build_jobs
    WHERE project_id = NEW.id
      AND status IN ('queued', 'processing')
      AND coin_hold_id IS NOT NULL
  )
  AND status = 'active';

  -- Return coins to user wallets
  UPDATE coin_wallets
  SET balance = balance + (
        SELECT COALESCE(SUM(coins_held), 0)
        FROM build_jobs
        WHERE project_id = NEW.id
          AND status IN ('queued', 'processing')
      ),
      updated_at = CURRENT_TIMESTAMP
  WHERE user_id = NEW.user_id
    AND EXISTS (
      SELECT 1 FROM build_jobs
      WHERE project_id = NEW.id
        AND status IN ('queued', 'processing')
        AND coins_held > 0
    );

  -- Mark stuck build jobs as cancelled
  UPDATE build_jobs
  SET status = 'cancelled',
      error_message = 'Project archived — build cancelled, coins returned.',
      completed_at = CURRENT_TIMESTAMP
  WHERE project_id = NEW.id
    AND status IN ('queued', 'processing');
END;
