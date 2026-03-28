-- Migration: 0004_admin_user
-- Creates the platform admin user and sets up admin_actions table

-- Admin actions log table (if not already exists from earlier migration)
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id)
);

-- Audit logs table (for all significant actions)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_id);

-- Insert admin user (password: Admin@Deploy2024!)
-- Hash generated with PBKDF2-SHA256, 100000 iterations
INSERT OR IGNORE INTO users (
  id, email, password_hash, name, role, status, email_verified, created_at, updated_at
) VALUES (
  'usr_admin_000000001',
  'admin@deployapp.io',
  '8e13884580d62fdccc967dc9c0258ae6:8944f9a600b76aa8958b70f54df924f8a128a5b77b3006533ba884c5dead847e',
  'Platform Admin',
  'admin',
  'active',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- Admin gets a Pro membership so they can access all models
INSERT OR IGNORE INTO memberships (
  id, user_id, plan_id, status, created_at, updated_at
) VALUES (
  'mem_admin_000000001',
  'usr_admin_000000001',
  'plan_pro',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- Admin wallet (no coins needed, but required for foreign keys)
INSERT OR IGNORE INTO coin_wallets (
  id, user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at
) VALUES (
  'wallet_admin_000000001',
  'usr_admin_000000001',
  999999,
  999999,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
