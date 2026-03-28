-- DEPLOY Platform - Complete D1 Schema
-- Migration: 0001_initial_schema

-- ============================================================
-- USERS & AUTH
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- user, admin
  status TEXT NOT NULL DEFAULT 'active', -- active, suspended, deleted
  email_verified INTEGER NOT NULL DEFAULT 0,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  two_factor_secret TEXT,
  last_login_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  device_info TEXT,
  ip_address TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- PLANS & MEMBERSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  monthly_coins INTEGER NOT NULL DEFAULT 0,
  max_rollover_coins INTEGER NOT NULL DEFAULT 0,
  max_projects INTEGER NOT NULL DEFAULT 5,
  max_uploads INTEGER NOT NULL DEFAULT 10,
  max_deployments INTEGER NOT NULL DEFAULT 2,
  max_concurrent_builds INTEGER NOT NULL DEFAULT 1,
  model_access TEXT NOT NULL DEFAULT '["gpt-4o-mini"]', -- JSON array
  priority_queue INTEGER NOT NULL DEFAULT 0,
  support_level TEXT NOT NULL DEFAULT 'community',
  stripe_price_id TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active, cancelled, expired, past_due
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  current_period_start DATETIME,
  current_period_end DATETIME,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- ============================================================
-- PAYMENT & BILLING
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_payment_method_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL, -- card, bank_account
  brand TEXT,
  last_four TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- subscription_created, subscription_renewed, coin_purchase, refund
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, completed, failed, refunded
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- COIN SYSTEM
-- ============================================================
CREATE TABLE IF NOT EXISTS coin_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0,
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  lifetime_spent INTEGER NOT NULL DEFAULT 0,
  last_grant_at DATETIME,
  next_grant_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coin_ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  type TEXT NOT NULL, -- grant, purchase, spend, refund, hold, release, expire, admin_adjust
  amount INTEGER NOT NULL, -- positive = credit, negative = debit
  balance_after INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_id TEXT, -- job_id, project_id, etc.
  reference_type TEXT, -- build_job, revision_job, purchase, etc.
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coin_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference_id TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active, released, settled, cancelled
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coin_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  coins INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  bonus_coins INTEGER NOT NULL DEFAULT 0,
  stripe_price_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- AI MODELS & PROVIDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  config TEXT, -- JSON - server-side only
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL, -- e.g. gpt-4o, claude-3-5-sonnet
  display_name TEXT NOT NULL,
  description TEXT,
  capability_tags TEXT NOT NULL DEFAULT '[]', -- JSON: ["fast","balanced","reasoning"]
  coin_cost_multiplier REAL NOT NULL DEFAULT 1.0,
  base_coin_cost INTEGER NOT NULL DEFAULT 10,
  max_context_tokens INTEGER,
  min_plan_slug TEXT NOT NULL DEFAULT 'free',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id)
);

CREATE TABLE IF NOT EXISTS model_usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  project_id TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  coins_spent INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT, -- saas, mobile, ecommerce, dashboard, api, other
  status TEXT NOT NULL DEFAULT 'draft', -- draft, building, built, deployed, archived
  current_version INTEGER NOT NULL DEFAULT 1,
  active_model_id TEXT,
  readiness_score INTEGER NOT NULL DEFAULT 0, -- 0-100
  thumbnail_r2_key TEXT,
  settings TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  change_summary TEXT,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============================================================
-- PROMPT SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, complete, submitted
  completeness_score INTEGER NOT NULL DEFAULT 0, -- 0-100
  mode TEXT NOT NULL DEFAULT 'guided', -- guided, advanced
  last_section TEXT,
  autosave_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompt_fields (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  section_key TEXT NOT NULL, -- app_name, category, audience, problem, features, etc.
  field_key TEXT NOT NULL,
  value TEXT,
  is_complete INTEGER NOT NULL DEFAULT 0,
  ai_assisted INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES prompt_sessions(id) ON DELETE CASCADE
);

-- ============================================================
-- BUILD JOBS & OUTPUTS
-- ============================================================
CREATE TABLE IF NOT EXISTS build_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'build', -- build, revision
  status TEXT NOT NULL DEFAULT 'queued', -- queued, processing, completed, failed, cancelled
  priority INTEGER NOT NULL DEFAULT 0,
  coins_held INTEGER NOT NULL DEFAULT 0,
  coins_settled INTEGER NOT NULL DEFAULT 0,
  coin_hold_id TEXT,
  prompt_snapshot TEXT, -- JSON snapshot of prompt at submission time
  result_summary TEXT,
  error_message TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generated_specs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  product_summary TEXT,
  feature_map TEXT, -- JSON
  screen_map TEXT, -- JSON
  role_map TEXT, -- JSON
  data_map TEXT, -- JSON
  workflow_map TEXT, -- JSON
  api_plan TEXT, -- JSON
  deployment_plan TEXT, -- JSON
  risk_flags TEXT, -- JSON
  missing_info_flags TEXT, -- JSON
  readiness_score INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT, -- full spec stored in R2
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES build_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generated_outputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL, -- spec, code, deployment_config, revision
  r2_key TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES build_jobs(id) ON DELETE CASCADE
);

-- ============================================================
-- REVISIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  job_id TEXT,
  version_number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'user_request', -- user_request, ai_suggestion
  status TEXT NOT NULL DEFAULT 'pending', -- pending, in_progress, completed, cancelled
  request_text TEXT NOT NULL,
  diff_summary TEXT,
  coins_cost INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_comments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (revision_id) REFERENCES revisions(id) ON DELETE CASCADE
);

-- ============================================================
-- DEPLOYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  job_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'production', -- production, staging
  status TEXT NOT NULL DEFAULT 'pending', -- pending, deploying, live, failed, rolled_back
  platform TEXT NOT NULL DEFAULT 'cloudflare',
  deployment_url TEXT,
  domain TEXT,
  cloudflare_project_name TEXT,
  cloudflare_deployment_id TEXT,
  config TEXT, -- JSON
  health_status TEXT, -- healthy, degraded, down, unknown
  last_health_check DATETIME,
  deployed_at DATETIME,
  rolled_back_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============================================================
-- FILE STORAGE (R2 references)
-- ============================================================
CREATE TABLE IF NOT EXISTS uploaded_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  purpose TEXT, -- project_asset, avatar, export, vault
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- build_complete, build_failed, coins_low, deployment_live, etc.
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  action_url TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  old_value TEXT, -- JSON, redacted PII
  new_value TEXT, -- JSON, redacted PII
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ADMIN & SYSTEM
-- ============================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  updated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open, in_progress, resolved, closed
  priority TEXT NOT NULL DEFAULT 'normal',
  admin_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_prompt_sessions_project ON prompt_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_user ON build_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_project ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs(status);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user ON coin_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_type ON coin_ledger_entries(type);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_user ON uploaded_files(user_id);
