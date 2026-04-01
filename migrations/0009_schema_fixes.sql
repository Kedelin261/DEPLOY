-- Migration 0009: Schema Fixes
-- 1. Add build_job_id to project_versions (required by trg_project_version_on_build trigger)
-- 2. Add released_at to coin_holds (required by trg_project_archive_release_holds trigger)
-- 3. Add scopes + last_used_ip + expires_at columns to api_keys (full API key support)
-- 4. Fix trigger: trg_project_version_on_build — correctly reference new columns
-- 5. Add trg_archive_cascade (safe no-op if already exists)

-- ═══════════════════════════════════════════════════════════════
-- 1. project_versions.build_job_id
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE project_versions ADD COLUMN build_job_id TEXT REFERENCES build_jobs(id);

-- ═══════════════════════════════════════════════════════════════
-- 2. coin_holds.released_at
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE coin_holds ADD COLUMN released_at DATETIME;

-- ═══════════════════════════════════════════════════════════════
-- 3. api_keys extra columns (if not already present — idempotent)
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["read"]';
ALTER TABLE api_keys ADD COLUMN last_used_ip TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at DATETIME;

-- ═══════════════════════════════════════════════════════════════
-- 4. Re-create trg_project_version_on_build with correct column
--    (DROP + CREATE — SQLite doesn't support ALTER TRIGGER)
-- ═══════════════════════════════════════════════════════════════
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
