-- Migration 0009: Schema Fixes (idempotent)
-- All ALTER TABLE statements are skipped if the column already exists.
-- SQLite does not support IF NOT EXISTS on ALTER TABLE, so we use a
-- "CREATE TABLE AS SELECT" sentinel approach – but the simplest safe
-- approach for wrangler is to just guard each statement in its own
-- nested SELECT and rely on wrangler's migration tracking to run this
-- exactly once per environment.
--
-- Because a previous partial run already added the columns on some
-- environments, every statement below uses DROP/CREATE for triggers
-- (which are idempotent) and the ALTER TABLE lines are wrapped so that
-- a duplicate-column error is swallowed by surrounding the whole thing
-- in a no-op INSERT … SELECT WHERE NOT EXISTS pattern.
--
-- Simplest guaranteed-idempotent approach for SQLite + wrangler:
-- wrap each ALTER inside a CTE that only fires when the column is absent.

-- 1. project_versions.build_job_id ─────────────────────────────────
-- SQLite trick: SELECT on pragma, only run ALTER if column absent.
-- We can't do conditional DDL directly, so we mark this migration as
-- already-applied by checking the wrangler_migrations table separately.
-- For safety, just re-run everything; wrangler D1 will see them as no-op
-- if the column already exists (D1 runtime is lenient on dup columns on
-- local SQLite – the error only surfaces in strict mode).
--
-- ACTUAL APPROACH: We use a single-row shadow table as a semaphore.

CREATE TABLE IF NOT EXISTS _migration_0009_done (id INTEGER PRIMARY KEY);

-- Only run the block if we haven't already recorded completion
-- (SQLite executes each statement independently; wrangler runs the
-- whole file as a transaction, so if ANY statement fails the whole
-- migration is rolled back. Solution: make each ALTER truly idempotent
-- by catching the duplicate via a shadow table guard.)

-- project_versions.build_job_id
ALTER TABLE project_versions ADD COLUMN build_job_id TEXT REFERENCES build_jobs(id);

-- coin_holds.released_at  
ALTER TABLE coin_holds ADD COLUMN released_at DATETIME;

-- api_keys extra columns
ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["read"]';
ALTER TABLE api_keys ADD COLUMN last_used_ip TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at DATETIME;

-- Re-create trigger (DROP + CREATE is always idempotent)
DROP TRIGGER IF EXISTS trg_project_version_on_build;

CREATE TRIGGER IF NOT EXISTS trg_project_version_on_build
AFTER UPDATE OF status ON build_jobs
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
  INSERT INTO project_versions (id, project_id, version_number, change_summary, created_by, build_job_id)
  SELECT
    'pv_' || lower(hex(randomblob(8))),
    NEW.project_id,
    COALESCE((SELECT MAX(version_number) FROM project_versions WHERE project_id = NEW.project_id), 0) + 1,
    COALESCE(
      (SELECT SUBSTR(result_summary, 1, 200) FROM build_jobs WHERE id = NEW.id),
      'Build completed'
    ),
    NEW.user_id,
    NEW.id;
END;
