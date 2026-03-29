// DEPLOY Platform - Type Definitions

export type Bindings = {
  // Cloudflare native services
  DB: D1Database;
  DEPLOY_KV: KVNamespace;
  DEPLOY_R2: R2Bucket;

  // Auth
  JWT_SECRET: string;

  // AI providers (server-side only — never exposed to clients)
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;

  // Stripe (server-side only)
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;   // returned to frontend via /api/config endpoint only
  STRIPE_WEBHOOK_SECRET: string;

  // Email (Resend)
  RESEND_API_KEY: string;
  FROM_EMAIL: string;               // e.g. noreply@deployapp.io
  FROM_NAME: string;                // e.g. DEPLOY Platform

  // Cloudflare account (for Workers API calls, R2 S3-compat presigned URLs)
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;

  // R2 S3-compatible credentials (for presigned upload/download URLs)
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  // App config
  APP_URL: string;
  ENVIRONMENT: string;
};

export type Variables = {
  user?: AuthUser;
  requestId: string;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  plan_slug: string;
  coin_balance: number;
};

export type ApiResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
};

export type User = {
  id: string;
  email: string;
  name: string;
  phone?: string;
  avatar_url?: string;
  role: string;
  status: string;
  email_verified: number;
  created_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  category?: string;
  status: string;
  current_version: number;
  readiness_score: number;
  active_model_id?: string;
  created_at: string;
  updated_at: string;
};

export type PromptSession = {
  id: string;
  user_id: string;
  project_id: string;
  version: number;
  status: string;
  completeness_score: number;
  mode: string;
  last_section?: string;
  fields?: PromptField[];
  created_at: string;
  updated_at: string;
};

export type PromptField = {
  id: string;
  session_id: string;
  section_key: string;
  field_key: string;
  value?: string;
  is_complete: number;
  ai_assisted: number;
};

export type BuildJob = {
  id: string;
  user_id: string;
  project_id: string;
  session_id: string;
  model_id: string;
  type: string;
  status: string;
  coins_held: number;
  coins_settled: number;
  result_summary?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
};

export type CoinWallet = {
  id: string;
  user_id: string;
  balance: number;
  lifetime_earned: number;
  lifetime_spent: number;
  last_grant_at?: string;
  next_grant_at?: string;
};

export type AiModel = {
  id: string;
  provider_id: string;
  name: string;
  model_id: string;
  display_name: string;
  description?: string;
  capability_tags: string[];
  coin_cost_multiplier: number;
  base_coin_cost: number;
  min_plan_slug: string;
  is_active: number;
  sort_order: number;
};

export type Deployment = {
  id: string;
  user_id: string;
  project_id: string;
  version: number;
  type: string;
  status: string;
  platform: string;
  deployment_url?: string;
  domain?: string;
  health_status?: string;
  deployed_at?: string;
  created_at: string;
};

export type PromptSections = {
  app_info: {
    app_name: string;
    category: string;
    audience: string;
    problem_statement: string;
  };
  features: {
    core_features: string;
    ui_ux_notes: string;
    roles_permissions: string;
  };
  technical: {
    workflows: string;
    data_entities: string;
    apis_tools: string;
  };
  business: {
    business_model: string;
    mvp_guardrails: string;
    future_versions: string;
  };
  deployment: {
    deployment_preferences: string;
    platform_notes: string;
  };
};
