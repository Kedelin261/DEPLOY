-- Migration: 0005_stripe_and_email_support.sql
-- Adds external_id to billing_events for Stripe session tracking,
-- creates user_billing table for Stripe customer IDs,
-- and adds updated_at to billing_events.

-- Add external_id column to billing_events (Stripe session / invoice ID for idempotency)
ALTER TABLE billing_events ADD COLUMN external_id TEXT;
ALTER TABLE billing_events ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Index for fast lookup by Stripe session/invoice ID
CREATE INDEX IF NOT EXISTS idx_billing_events_external ON billing_events(external_id);

-- user_billing: stores Stripe customer ID and subscription ID per user
-- Separate from memberships to keep Stripe concerns isolated
CREATE TABLE IF NOT EXISTS user_billing (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_payment_method_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_billing_stripe_customer ON user_billing(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_user_billing_user ON user_billing(user_id);
