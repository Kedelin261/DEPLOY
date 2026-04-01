-- Migration: 0006_platform_hardening.sql
-- Phase 1-3 Platform Hardening: Rate Limits, Intent Log, Spec Transformer,
-- Coin Analytics, Model Usage by Project, Education Events, Support Tickets index

-- ============================================================
-- RATE LIMITING
-- Sliding-window rate limit counters stored in D1 (edge-safe)
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,           -- e.g. "auth:login:<ip>" or "user:<id>:build"
  window_start DATETIME NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limits_key_window ON rate_limits(key, window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);

-- ============================================================
-- INTENT EXECUTION LOG
-- Permanent audit trail for every Intent Layer execution.
-- Satisfies: "Log changes" and "Intent Layer enforced" mandates.
-- ============================================================
CREATE TABLE IF NOT EXISTS intent_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  project_id TEXT,
  intent TEXT NOT NULL,        -- generate_spec, generate_revision, chat, etc.
  model_id TEXT,
  input_hash TEXT,             -- SHA-256 of request payload (privacy-safe)
  output_summary TEXT,         -- first 500 chars of output
  coins_charged INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  provider_used TEXT,          -- openai, anthropic, demo
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success',   -- success, failed, fallback
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intent_log_user ON intent_log(user_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_intent ON intent_log(intent);
CREATE INDEX IF NOT EXISTS idx_intent_log_project ON intent_log(project_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_created ON intent_log(created_at);

-- ============================================================
-- SPECIFICATION TRANSFORMER OUTPUT
-- Stores the structured breakdown produced by the Spec Transformer:
-- feature_map, screen_map, data_model, api_contracts,
-- arch_summary, deployment_reqs, env_vars
-- ============================================================
CREATE TABLE IF NOT EXISTS spec_breakdowns (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- Structured outputs (JSON)
  feature_map TEXT,            -- [{name, description, priority, category}]
  screen_map TEXT,             -- [{name, route, components, auth_required}]
  data_model TEXT,             -- [{table, fields:[{name,type,constraints}]}]
  api_contracts TEXT,          -- [{method, path, auth, request, response, errors}]
  arch_summary TEXT,           -- plain text paragraph
  deployment_reqs TEXT,        -- [{platform, config_key, value}]
  env_vars TEXT,               -- [{name, description, required, example}]
  risk_flags TEXT,             -- [{level, area, description, mitigation}]
  readiness_score INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES build_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spec_breakdowns_project ON spec_breakdowns(project_id);
CREATE INDEX IF NOT EXISTS idx_spec_breakdowns_job ON spec_breakdowns(job_id);

-- ============================================================
-- COIN ANALYTICS (per-model, per-project aggregates)
-- Powers the Financial Control Center.
-- ============================================================
CREATE TABLE IF NOT EXISTS coin_analytics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,         -- YYYY-MM  (monthly bucket)
  model_id TEXT,
  project_id TEXT,
  intent TEXT,                  -- build, revision, chat, summary, ai_assist
  coins_spent INTEGER NOT NULL DEFAULT 0,
  operation_count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, period, model_id, project_id, intent)
);
CREATE INDEX IF NOT EXISTS idx_coin_analytics_user_period ON coin_analytics(user_id, period);
CREATE INDEX IF NOT EXISTS idx_coin_analytics_project ON coin_analytics(project_id);

-- ============================================================
-- ONBOARDING PROGRESS
-- Tracks user completion of onboarding steps.
-- Powers the Education Hub completion state.
-- ============================================================
CREATE TABLE IF NOT EXISTS onboarding_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  completed_steps TEXT NOT NULL DEFAULT '[]',  -- JSON array of step keys
  current_step TEXT,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- PLATFORM HEALTH METRICS
-- Lightweight metric snapshots for the admin command centre.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_metrics (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,   -- daily_active_users, builds_today, revenue_today, etc.
  metric_value REAL NOT NULL DEFAULT 0,
  dimensions TEXT,            -- JSON {date, model_id, plan_slug, …}
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_metrics_key ON platform_metrics(metric_key, recorded_at);

-- ============================================================
-- MISSING CONSTRAINT: prompt_fields unique index
-- Ensures ON CONFLICT works correctly in the PUT /field endpoint
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_fields_session_field
  ON prompt_fields(session_id, field_key);

-- ============================================================
-- MISSING COLUMN: coins_held on build_jobs
-- Ensure the column that the build route reads exists
-- ============================================================
-- (Already in schema, but add result_url for direct download links)
ALTER TABLE build_jobs ADD COLUMN result_url TEXT;

-- ============================================================
-- DEPLOYMENT: add download_url for project file download
-- ============================================================
ALTER TABLE deployments ADD COLUMN download_url TEXT;
ALTER TABLE deployments ADD COLUMN coins_spent INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- USER BILLING: add plan columns for quick subscription reads
-- ============================================================
ALTER TABLE user_billing ADD COLUMN current_plan_slug TEXT;
ALTER TABLE user_billing ADD COLUMN subscription_status TEXT;

-- ============================================================
-- INDEXES OPTIMISING COMMON QUERIES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_build_jobs_created ON build_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_specs_project ON generated_specs(project_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_user ON model_usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage_events(model_id);
