# DEPLOY — AI App Builder Platform

> **From Idea to App. One Prompt.**

A premium, production-ready AI-powered app builder platform that transforms ideas, descriptions, and plans into structured software builds and deployment-ready products.

---

## 🚀 Live App

- **Local Dev**: http://localhost:3000
- **Health Check**: http://localhost:3000/api/health
- **Demo Login**: `demo@deployapp.io` / `Demo12345`

---

## ✅ Implemented Features (MVP)

### Core Platform
- **Authentication** — JWT auth, signup/login, password change, profile update
- **Projects** — Create, manage, archive projects with plan-based limits
- **Prompt Builder** — Interactive 5-section prompt form with autosave, AI assist, progress tracking
- **Build Jobs** — Coin-gated AI build requests with hold/settle ledger
- **Coin System** — Full wallet, ledger, holds, grants, purchases, vault display
- **Model Switcher** — Multi-model dropdown (GPT-4o Mini, GPT-4o, Claude 3.5, o1)
- **Deployments** — Cloudflare-native deployment records and status
- **Notifications** — Real-time unread badge and notification list
- **Admin Panel** — User management, coin adjustments, feature flags, job queue

### Navigation (4 Bottom Tabs)
1. **Home** — Command center: coin balance, recent projects, quick actions, activity
2. **Prompt** — Interactive app blueprint builder with AI assist + copy full prompt
3. **Account** — Profile, coin vault, plan details, security settings
4. **Info** — How it works guide, coin system explainer, model guide, FAQ

### Design System
- Premium dark theme: navy (`#0a0e1a`) + cyan (`#22d3ee`) + amber (`#fbbf24`)
- Glass-morphism cards with subtle glow effects
- Futuristic minimalist DEPLOY logo
- Mobile-first responsive layout
- Smooth animations and transitions

---

## 📐 Architecture

```
Frontend (SPA) ←→ Hono API (Cloudflare Workers) ←→ D1 (SQLite) + R2 + KV
                        ↓
                   Intent Layer
                        ↓
              AI Service (OpenAI / Anthropic)
              [Keys stored server-side ONLY]
```

### Key Rules
- **Intent Layer**: ALL AI operations route through `AIService.processIntent()`
- **No BYOK**: Provider keys never exposed to clients
- **Coin Ledger**: Every coin change is recorded immutably
- **Cloudflare-only**: D1 for data, R2 for files, KV for cache

---

## 🗄️ Data Model (32 Tables)

| Category | Tables |
|----------|--------|
| Auth | users, sessions, password_resets |
| Plans | plans, memberships |
| Billing | payment_methods, billing_events |
| Coins | coin_wallets, coin_ledger_entries, coin_holds, coin_packages |
| AI | ai_providers, ai_models, model_usage_events |
| Projects | projects, project_versions |
| Prompts | prompt_sessions, prompt_fields |
| Builds | build_jobs, generated_specs, generated_outputs |
| Revisions | revisions, revision_comments |
| Deployments | deployments |
| Files | uploaded_files |
| System | notifications, audit_logs, feature_flags, admin_actions, support_tickets |

---

## 💰 Coin Economy

| Action | Cost |
|--------|------|
| AI Assist (field) | 2 coins |
| Build (GPT-4o Mini) | ~15 coins |
| Build (GPT-4o) | ~45 coins |
| Build (Claude Sonnet) | ~75 coins |
| Revision | ~10 coins |
| Deployment | 15 coins |

| Plan | Monthly Coins | Price |
|------|--------------|-------|
| Free | 50 | $0 |
| Member | 500 | $19/mo |
| Pro | 2,000 | $49/mo |
| Team | 8,000 | $149/mo |

---

## 🤖 AI Models

| Model | Plan | Cost Multiplier |
|-------|------|----------------|
| GPT-4o Mini | Free | 1x |
| GPT-4o | Member | 3x |
| Claude 3.5 Haiku | Member | 2x |
| Claude 3.5 Sonnet | Pro | 5x |
| o1-mini | Pro | 6x |
| Claude 3 Opus | Team | 10x |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | Hono v4 |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Cache | Cloudflare KV |
| Auth | JWT + PBKDF2 |
| Frontend | Vanilla JS SPA + Tailwind CDN |
| Build | Vite + @hono/vite-cloudflare-pages |
| Dev Server | PM2 + wrangler pages dev |

---

## 🚀 Local Development

```bash
# Install dependencies
npm install

# Apply DB migrations
npm run db:migrate:local

# Seed with demo data (optional)
npm run db:seed:local

# Build
npm run build

# Start dev server
pm2 start ecosystem.config.cjs

# Health check
curl http://localhost:3000/api/health
```

---

## 📦 Deploy to Cloudflare

```bash
# 1. Setup Cloudflare API key
# Set CLOUDFLARE_API_TOKEN env var

# 2. Create D1 database
npx wrangler d1 create deploy-production
# Copy the database_id into wrangler.jsonc

# 3. Create R2 bucket
npx wrangler r2 bucket create deploy-assets

# 4. Apply migrations
npm run db:migrate:prod

# 5. Set secrets
npx wrangler pages secret put JWT_SECRET
npx wrangler pages secret put OPENAI_API_KEY
npx wrangler pages secret put ANTHROPIC_API_KEY

# 6. Build and deploy
npm run deploy:prod
```

---

## 🔌 API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/signup | — | Register new user |
| POST | /api/auth/login | — | Login |
| GET | /api/auth/me | ✅ | Get current user |
| PUT | /api/auth/profile | ✅ | Update profile |
| GET | /api/projects | ✅ | List projects |
| POST | /api/projects | ✅ | Create project |
| POST | /api/projects/:id/build | ✅ | Submit build job |
| GET | /api/prompt/:id | ✅ | Get prompt session |
| PUT | /api/prompt/:id/field | ✅ | Save field |
| POST | /api/prompt/:id/ai-assist | ✅ | AI field assist |
| GET | /api/prompt/:id/export | ✅ | Export full prompt |
| GET | /api/vault | ✅ | Vault summary |
| POST | /api/vault/purchase | ✅ | Buy coins |
| GET | /api/models | ✅ | List AI models |
| PUT | /api/models/select | ✅ | Set active model |
| POST | /api/deployments | ✅ | Request deployment |
| GET | /api/plans | — | List plans |
| GET | /api/health | — | Health check |

---

## 🔒 Security

- JWT tokens (7-day expiry, HMAC-SHA256)
- PBKDF2 password hashing (100K iterations)
- Provider API keys stored server-side only (never exposed to client)
- RBAC with admin/user roles
- Audit logs for all sensitive actions
- Coin holds prevent double-spending

---

## ⚠️ Phase 2 (Not in MVP)

- Stripe payment integration
- Resend email transactional
- Full Cloudflare Queues async processing
- Revision diff engine
- Real Cloudflare Pages deployment API
- Mobile app (Expo React Native)
- 2FA / SSO
- Team collaboration
- Analytics dashboard
- Webhook system

---

## 📊 Deployment Status

- **Platform**: Cloudflare Pages (ready)
- **Status**: ✅ Local development active
- **Version**: 1.0.0 MVP
- **Last Updated**: 2026-03-28
