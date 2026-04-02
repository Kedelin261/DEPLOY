-- Migration 0010: Grace period enforcement + idempotency improvements
-- Adds grace_expires_at to user_billing for subscription cancellation grace period.
-- Adds index on build_jobs.prompt_snapshot for idempotency key lookups.

-- Grace period: stores when the 3-day post-cancellation grace period expires
ALTER TABLE user_billing ADD COLUMN grace_expires_at DATETIME;

-- Index to help cron find expired grace periods quickly
CREATE INDEX IF NOT EXISTS idx_user_billing_grace ON user_billing(grace_expires_at)
  WHERE grace_expires_at IS NOT NULL;

-- Index to speed up idempotency key lookups in build_jobs (LIKE query on prompt_snapshot)
-- SQLite doesn't support partial indexes on expressions, so index the whole column
CREATE INDEX IF NOT EXISTS idx_build_jobs_snapshot ON build_jobs(prompt_snapshot);
