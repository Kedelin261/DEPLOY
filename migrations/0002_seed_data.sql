-- DEPLOY Platform - Seed Data
-- Migration: 0002_seed_data

-- Plans
INSERT OR IGNORE INTO plans (id, name, slug, description, monthly_coins, max_rollover_coins, max_projects, max_uploads, max_deployments, max_concurrent_builds, model_access, price_cents) VALUES
  ('plan_free', 'Free', 'free', 'Get started with the basics', 50, 25, 3, 5, 1, 1, '["gpt-4o-mini"]', 0),
  ('plan_member', 'Member', 'member', 'For serious builders', 500, 250, 15, 25, 5, 2, '["gpt-4o-mini","gpt-4o","claude-3-5-haiku"]', 1900),
  ('plan_pro', 'Pro', 'pro', 'For operators and consultants', 2000, 1000, 50, 100, 20, 5, '["gpt-4o-mini","gpt-4o","claude-3-5-sonnet","claude-3-5-haiku","o1-mini"]', 4900),
  ('plan_team', 'Team', 'team', 'For agencies and teams', 8000, 4000, 200, 500, 100, 10, '["gpt-4o-mini","gpt-4o","gpt-4o-latest","claude-3-5-sonnet","claude-3-opus","o1","o1-mini"]', 14900);

-- AI Providers
INSERT OR IGNORE INTO ai_providers (id, name, slug, is_active) VALUES
  ('prov_openai', 'OpenAI', 'openai', 1),
  ('prov_anthropic', 'Anthropic', 'anthropic', 1);

-- AI Models
INSERT OR IGNORE INTO ai_models (id, provider_id, name, model_id, display_name, description, capability_tags, coin_cost_multiplier, base_coin_cost, max_context_tokens, min_plan_slug, is_active, sort_order) VALUES
  ('model_gpt4o_mini', 'prov_openai', 'GPT-4o Mini', 'gpt-4o-mini', 'GPT-4o Mini', 'Fast, efficient, great for most tasks', '["fast","balanced","coding"]', 1.0, 5, 128000, 'free', 1, 1),
  ('model_gpt4o', 'prov_openai', 'GPT-4o', 'gpt-4o', 'GPT-4o', 'Most capable for complex builds', '["premium","balanced","long-context","coding"]', 3.0, 15, 128000, 'member', 1, 2),
  ('model_claude_haiku', 'prov_anthropic', 'Claude 3.5 Haiku', 'claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', 'Lightning fast reasoning', '["fast","reasoning","coding"]', 2.0, 10, 200000, 'member', 1, 3),
  ('model_claude_sonnet', 'prov_anthropic', 'Claude 3.5 Sonnet', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', 'Best for complex architectures', '["premium","reasoning","long-context","coding"]', 5.0, 25, 200000, 'pro', 1, 4),
  ('model_o1_mini', 'prov_openai', 'o1-mini', 'o1-mini', 'o1 Mini', 'Deep reasoning for hard problems', '["reasoning","premium"]', 6.0, 30, 128000, 'pro', 1, 5),
  ('model_claude_opus', 'prov_anthropic', 'Claude 3 Opus', 'claude-3-opus-20240229', 'Claude 3 Opus', 'Most powerful for enterprise builds', '["premium","reasoning","long-context"]', 10.0, 50, 200000, 'team', 1, 6);

-- Coin Packages
INSERT OR IGNORE INTO coin_packages (id, name, coins, price_cents, bonus_coins) VALUES
  ('pkg_starter', 'Starter Pack', 100, 499, 0),
  ('pkg_boost', 'Boost Pack', 500, 1999, 50),
  ('pkg_power', 'Power Pack', 1500, 4999, 250),
  ('pkg_elite', 'Elite Pack', 5000, 14999, 1000);

-- Feature Flags
INSERT OR IGNORE INTO feature_flags (id, key, value, description) VALUES
  ('ff_001', 'ai_builds_enabled', 'true', 'Enable AI build requests'),
  ('ff_002', 'coin_purchases_enabled', 'true', 'Enable coin purchases'),
  ('ff_003', 'deployments_enabled', 'true', 'Enable deployment feature'),
  ('ff_004', 'maintenance_mode', 'false', 'Maintenance mode flag');
