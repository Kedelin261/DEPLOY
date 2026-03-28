-- Migration: 0003_constraints_and_demo

-- Add unique constraint on prompt_fields (session_id + field_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_fields_session_field 
ON prompt_fields(session_id, field_key);

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_prompt_fields_session ON prompt_fields(session_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_user ON model_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_holds_user ON coin_holds(user_id);
