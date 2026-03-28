// DEPLOY Platform - Prompt Session Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { AIService } from '../services/ai.service';
import type { Bindings, Variables } from '../types';

const prompt = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── Section registry ─────────────────────────────────────────────────────────
// Core sections contribute to the completeness score (total 100 pts).
// Optional sections (visual, comments) give bonus points when filled but are
// never required — they are excluded from the denominator so the score can
// reach 100 % without them.

const CORE_SECTIONS = [
  { key: 'app_info',    label: 'App Info',       weight: 25, fields: ['app_name','category','audience','problem_statement'] },
  { key: 'features',   label: 'Core Features',   weight: 25, fields: ['core_features','roles_permissions'] },
  { key: 'technical',  label: 'Technical',        weight: 20, fields: ['workflows','data_entities','apis_tools'] },
  { key: 'business',   label: 'Business',         weight: 20, fields: ['business_model','mvp_guardrails','future_versions'] },
  { key: 'deployment', label: 'Deployment',       weight: 10, fields: ['deployment_preferences','platform_notes'] },
];

const OPTIONAL_SECTIONS = [
  {
    key: 'visual',   label: 'Visual & Frontend', weight: 0,
    fields: ['color_scheme','visual_style','visual_features','ui_ux_notes']
  },
  {
    key: 'comments', label: 'Additional Comments', weight: 0,
    fields: ['additional_comments']
  },
];

const ALL_SECTIONS = [...CORE_SECTIONS, ...OPTIONAL_SECTIONS];

// ── Completeness calculation ─────────────────────────────────────────────────
// Only core fields count toward the 0-100 score.
// A feature-list field counts when it has ≥ 1 non-empty item.
// A color-scheme field counts when it has any value.
// All other fields count when trimmed length > 5.

function fieldIsFilled(key: string, value: string | undefined): boolean {
  if (!value) return false;
  // Feature lists stored as JSON arrays
  if (value.startsWith('[')) {
    try {
      const arr: string[] = JSON.parse(value);
      return arr.some(x => x && x.trim().length > 0);
    } catch {
      return value.trim().length > 0;
    }
  }
  // Color-scheme: any non-empty string
  if (['color_scheme', 'visual_style'].includes(key)) return value.trim().length > 0;
  return value.trim().length > 5;
}

function calculateCompleteness(fields: Record<string, string>): number {
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const section of CORE_SECTIONS) {
    const fieldWeight = section.weight / section.fields.length;
    totalWeight += section.weight;
    for (const fk of section.fields) {
      if (fieldIsFilled(fk, fields[fk])) earnedWeight += fieldWeight;
    }
  }

  return Math.min(100, Math.round((earnedWeight / totalWeight) * 100));
}

// ── Prompt export formatter ──────────────────────────────────────────────────
// Follows the mandatory execution order specified in the master prompt:
//   Goal → Roles → Workflows → Screens → Data model → Storage model →
//   API contracts → Auth/security → Coin/billing → Deployment flow →
//   Infrastructure → Folder structure → Implementation plan →
//   Env vars → CI/CD → Code

function formatFeatureList(raw: string): string {
  if (!raw) return 'Not specified.';
  try {
    const arr: string[] = JSON.parse(raw);
    const items = arr.filter(x => x && x.trim().length > 0);
    return items.length > 0 ? items.map((x, i) => `  ${i + 1}. ${x.trim()}`).join('\n') : 'Not specified.';
  } catch {
    return raw.trim() || 'Not specified.';
  }
}

function val(fields: Record<string, string>, key: string, fallback = 'Not specified.'): string {
  const v = fields[key];
  return (v && v.trim()) ? v.trim() : fallback;
}

function buildStructuredPrompt(
  fields: Record<string, string>,
  projectName: string,
  score: number
): string {
  const appName  = val(fields, 'app_name', projectName || 'My App');
  const category = val(fields, 'category');
  const audience = val(fields, 'audience');
  const problem  = val(fields, 'problem_statement');

  // Visual
  const colorScheme    = val(fields, 'color_scheme', 'Cyber (default)');
  const visualStyle    = val(fields, 'visual_style', 'Minimal & Clean');
  const visualFeatures = formatFeatureList(fields['visual_features'] || '');
  const uiUxNotes      = val(fields, 'ui_ux_notes', 'None specified.');
  const hasVisual      = fields['color_scheme'] || fields['visual_style'] || fields['visual_features'] || fields['ui_ux_notes'];

  // Features
  const coreFeatures    = formatFeatureList(fields['core_features'] || '');
  const roles           = val(fields, 'roles_permissions');

  // Technical
  const workflows       = val(fields, 'workflows');
  const dataEntities    = val(fields, 'data_entities');
  const apisTools       = val(fields, 'apis_tools');

  // Business
  const businessModel   = val(fields, 'business_model');
  const mvpGuardrails   = val(fields, 'mvp_guardrails');
  const futureVersions  = val(fields, 'future_versions');

  // Deployment
  const deployPrefs     = val(fields, 'deployment_preferences');
  const platformNotes   = val(fields, 'platform_notes');

  // Additional comments
  const comments        = val(fields, 'additional_comments', '');

  // ── Build the prompt ───────────────────────────────────────────────────────
  let p = '';

  // Header
  p += `# DEPLOY App Blueprint — ${appName}\n`;
  p += `# Prompt Completeness: ${score}% | Category: ${category}\n`;
  p += `# Generated by DEPLOY Platform — All Cloudflare-native architecture\n\n`;
  p += `${'═'.repeat(72)}\n\n`;

  // ── 1. ROLE & MISSION ──────────────────────────────────────────────────────
  p += `## 1. ROLE & MISSION\n\n`;
  p += `You are a world-class full-stack engineer and product architect.  \n`;
  p += `Your mission is to build **${appName}** — a production-ready, fully deployable application.\n\n`;
  p += `**App Category:** ${category}\n`;
  p += `**Target Audience:** ${audience}\n`;
  p += `**Core Problem Solved:**\n${problem}\n\n`;

  // ── 2. NON-NEGOTIABLE RULES ────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 2. NON-NEGOTIABLE ARCHITECTURE RULES\n\n`;
  p += `- ALL infrastructure must use **Cloudflare-native services only**: Workers, Pages, D1, R2, KV, Queues, Durable Objects.\n`;
  p += `- Backend: **Hono** framework on **Cloudflare Workers**.\n`;
  p += `- Web frontend: **Next.js** (Cloudflare-compatible) or a static SPA served via Cloudflare Pages.\n`;
  p += `- Mobile (if in scope): **Expo React Native**.\n`;
  p += `- Database: **Cloudflare D1** (SQLite). Migrations required.\n`;
  p += `- File/media storage: **Cloudflare R2**.\n`;
  p += `- Caching / ephemeral data: **Cloudflare KV**.\n`;
  p += `- Background jobs: **Cloudflare Queues** or **Durable Objects** (no long-running servers).\n`;
  p += `- **No customer-facing API-key fields.** All third-party keys live in Cloudflare secrets (wrangler secret put).\n`;
  p += `- **All new logic must pass through the Intent Layer.** No direct action-layer rewrites.\n`;
  p += `- **MVP scope is locked** to the features listed in §4. Nothing extra.\n\n`;

  // ── 3. MANDATORY EXECUTION ORDER ──────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 3. MANDATORY EXECUTION ORDER\n\n`;
  p += `Follow this exact sequence — do NOT skip or reorder steps:\n\n`;
  p += `1. Define the goal and success criteria\n`;
  p += `2. Define roles, permissions, and trust boundaries\n`;
  p += `3. Map all required workflows (entry → validation → success/fail → audit → coin effect)\n`;
  p += `4. Design all screens and UI states\n`;
  p += `5. Define the data model (D1 schema + migrations)\n`;
  p += `6. Define the storage model (R2 buckets, KV namespaces)\n`;
  p += `7. Write all API contracts (endpoint, method, auth, request shape, response shape, errors)\n`;
  p += `8. Implement auth and security (JWT, session management, rate limiting, input validation)\n`;
  p += `9. Implement coin/billing logic (if applicable)\n`;
  p += `10. Define the deployment flow (CI/CD, wrangler.jsonc, environment matrix)\n`;
  p += `11. Define infrastructure (Workers, Pages, D1, R2, KV, Queues binding names)\n`;
  p += `12. Lay out the folder structure\n`;
  p += `13. Write the implementation plan (ordered task list)\n`;
  p += `14. List all environment variables and secrets\n`;
  p += `15. Specify the CI/CD pipeline\n`;
  p += `16. Write production-ready code for the full stack\n\n`;

  // ── 4. CORE FEATURES (MVP SCOPE) ───────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 4. CORE FEATURES — MVP SCOPE\n\n`;
  p += `${coreFeatures}\n\n`;
  p += `**User Roles & Permissions:**\n${roles}\n\n`;
  p += `**MVP Guardrails (explicitly OUT of v1):**\n${mvpGuardrails}\n\n`;
  p += `**Future Versions (v2+):**\n${futureVersions}\n\n`;

  // ── 5. WORKFLOWS ───────────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 5. KEY WORKFLOWS\n\n`;
  p += `For each workflow below, implement: entry point → input validation → success path → failure path → audit log entry → coin/billing effect (if any).\n\n`;
  p += `${workflows}\n\n`;

  // ── 6. VISUAL & FRONTEND DESIGN ────────────────────────────────────────────
  if (hasVisual) {
    p += `${'─'.repeat(72)}\n`;
    p += `## 6. VISUAL & FRONTEND DESIGN\n\n`;
    p += `> AI handles all frontend implementation. The specs below are design direction — fill in anything not stated.\n\n`;
    p += `**Color Scheme:** ${colorScheme}\n`;
    p += `**Visual Style:** ${visualStyle}\n\n`;
    if (fields['visual_features']) {
      p += `**Specific Frontend Features Requested:**\n${visualFeatures}\n\n`;
    }
    if (fields['ui_ux_notes']) {
      p += `**Additional UI/UX Notes:**\n${uiUxNotes}\n\n`;
    }
    p += `**General UI Requirements:**\n`;
    p += `- Mobile-first responsive layout\n`;
    p += `- Accessible (WCAG 2.1 AA minimum)\n`;
    p += `- Consistent loading states, empty states, and error states for every screen\n`;
    p += `- Toast notifications for all async actions\n`;
    p += `- Optimistic UI updates where appropriate\n\n`;
  } else {
    p += `${'─'.repeat(72)}\n`;
    p += `## 6. VISUAL & FRONTEND DESIGN\n\n`;
    p += `> No specific design direction provided. AI has full creative control over the visual design.\n`;
    p += `> Apply a professional, modern aesthetic appropriate for: ${category}.\n\n`;
    p += `**General UI Requirements:**\n`;
    p += `- Mobile-first responsive layout\n`;
    p += `- Accessible (WCAG 2.1 AA minimum)\n`;
    p += `- Consistent loading, empty, and error states for every screen\n`;
    p += `- Toast notifications for async actions\n\n`;
  }

  // ── 7. DATA MODEL ──────────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 7. DATA MODEL\n\n`;
  p += `**Primary Data Entities:**\n${dataEntities}\n\n`;
  p += `**Requirements:**\n`;
  p += `- All tables in Cloudflare D1 (SQLite)\n`;
  p += `- Migrations in /migrations/*.sql — numbered, idempotent, with IF NOT EXISTS guards\n`;
  p += `- Every table must have: id (TEXT, prefixed nanoid), created_at, updated_at\n`;
  p += `- Foreign keys + indexes for all join columns\n\n`;

  // ── 8. STORAGE MODEL ──────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 8. STORAGE MODEL\n\n`;
  p += `- **R2 Buckets:** One per logical asset type (e.g., user-uploads, build-artifacts)\n`;
  p += `- **KV Namespaces:** Session cache, feature flags, rate-limit counters\n`;
  p += `- **D1:** All structured/relational data (see §7)\n`;
  p += `- All R2 objects: private by default, signed URLs for access\n\n`;

  // ── 9. API CONTRACTS ───────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 9. API CONTRACTS\n\n`;
  p += `**Third-Party APIs & Integrations:**\n${apisTools}\n\n`;
  p += `**API Contract Format** — for every endpoint define:\n`;
  p += `\`METHOD /path\` | Auth required | Request body (JSON) | Response (200) | Error codes\n\n`;
  p += `**General Rules:**\n`;
  p += `- All responses: \`{ success: boolean, data?: any, error?: string }\`\n`;
  p += `- Authenticated routes: Bearer JWT in Authorization header\n`;
  p += `- Rate limiting on all public and auth endpoints\n`;
  p += `- Input validation on every body, query, and path param\n\n`;

  // ── 10. AUTH & SECURITY ────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 10. AUTH & SECURITY\n\n`;
  p += `- JWT-based authentication (short-lived access tokens, optional refresh tokens in KV)\n`;
  p += `- Passwords: PBKDF2-SHA256 with per-user salt (no bcrypt — Workers-compatible only)\n`;
  p += `- CORS: locked to production origin + localhost in dev\n`;
  p += `- All secrets in Cloudflare secrets (wrangler secret put). Zero secrets in code or config files.\n`;
  p += `- Audit log: every sensitive action writes to an audit_logs table (user_id, action, entity, ip, ts)\n\n`;

  // ── 11. BUSINESS MODEL ─────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 11. BUSINESS MODEL\n\n`;
  p += `${businessModel}\n\n`;

  // ── 12. DEPLOYMENT & INFRASTRUCTURE ───────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 12. DEPLOYMENT & INFRASTRUCTURE\n\n`;
  p += `**Deployment Preferences:**\n${deployPrefs}\n\n`;
  p += `**Platform Notes:**\n${platformNotes}\n\n`;
  p += `**Required Cloudflare Resources:**\n`;
  p += `- Pages project (frontend)\n`;
  p += `- Workers (API backend)\n`;
  p += `- D1 database (production + local dev via --local flag)\n`;
  p += `- R2 bucket(s)\n`;
  p += `- KV namespace(s)\n`;
  p += `- Queues (if background jobs are needed)\n\n`;
  p += `**wrangler.jsonc must define:** name, compatibility_date, pages_build_output_dir or main, all d1_databases, kv_namespaces, r2_buckets, queues bindings.\n\n`;

  // ── 13. FOLDER STRUCTURE ──────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 13. RECOMMENDED FOLDER STRUCTURE\n\n`;
  p += `\`\`\`\n`;
  p += `${appName.toLowerCase().replace(/\s+/g, '-')}/\n`;
  p += `├── src/\n`;
  p += `│   ├── index.tsx          # Hono app entry point\n`;
  p += `│   ├── routes/            # Route handlers (one file per domain)\n`;
  p += `│   ├── services/          # Business logic & intent layer\n`;
  p += `│   ├── middleware/        # Auth, rate-limit, logging\n`;
  p += `│   └── types/             # TypeScript type definitions\n`;
  p += `├── public/\n`;
  p += `│   └── static/            # CSS, JS, images\n`;
  p += `├── migrations/            # D1 SQL migrations (numbered)\n`;
  p += `├── .dev.vars              # Local secrets (never commit)\n`;
  p += `├── wrangler.jsonc         # Cloudflare configuration\n`;
  p += `├── package.json\n`;
  p += `└── tsconfig.json\n`;
  p += `\`\`\`\n\n`;

  // ── 14. ENVIRONMENT VARIABLES ──────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 14. ENVIRONMENT VARIABLES & SECRETS\n\n`;
  p += `Store via \`wrangler secret put <NAME>\` for production. Use \`.dev.vars\` for local dev.\n\n`;
  p += `| Variable | Description | Required |\n`;
  p += `|----------|-------------|----------|\n`;
  p += `| JWT_SECRET | Secret key for signing JWTs | ✅ |\n`;
  p += `| OPENAI_API_KEY | AI provider key (server-side only) | ✅ |\n`;
  p += `| STRIPE_SECRET_KEY | Payments (if applicable) | Optional |\n`;
  p += `| SMTP_* | Email service credentials | Optional |\n\n`;
  p += `(Extend this table with any keys referenced in §9.)\n\n`;

  // ── 15. CI/CD ──────────────────────────────────────────────────────────────
  p += `${'─'.repeat(72)}\n`;
  p += `## 15. CI/CD PIPELINE\n\n`;
  p += `- **Repository:** GitHub (main branch = production)\n`;
  p += `- **Build:** \`npm run build\` → outputs dist/\n`;
  p += `- **Deploy:** \`wrangler pages deploy dist --project-name ${appName.toLowerCase().replace(/\s+/g, '-')}\`\n`;
  p += `- **DB migrations:** \`wrangler d1 migrations apply <db-name>\` — run before each deploy\n`;
  p += `- **Env vars:** Cloudflare Pages > Settings > Environment variables (set via wrangler secret put)\n`;
  p += `- **Preview deploys:** every PR gets a unique preview URL (Cloudflare Pages default behaviour)\n\n`;

  // ── 16. ADDITIONAL COMMENTS ────────────────────────────────────────────────
  if (comments && comments.trim().length > 0) {
    p += `${'─'.repeat(72)}\n`;
    p += `## 16. ADDITIONAL CONTEXT & IDEAS\n\n`;
    p += `> Direct from the product owner — read carefully before coding:\n\n`;
    p += `${comments}\n\n`;
  }

  // ── DELIVERY STANDARD ─────────────────────────────────────────────────────
  p += `${'═'.repeat(72)}\n`;
  p += `## DELIVERY STANDARD\n\n`;
  p += `The final deliverable must include, in order:\n\n`;
  p += `1. Architecture overview diagram (ASCII or Mermaid)\n`;
  p += `2. Complete D1 schema with all migrations\n`;
  p += `3. All API contracts (spec table format)\n`;
  p += `4. Full folder structure\n`;
  p += `5. Ordered implementation plan (numbered task list)\n`;
  p += `6. All environment variables listed\n`;
  p += `7. CI/CD setup instructions\n`;
  p += `8. Production-ready starter code for the full stack\n\n`;
  p += `**System Philosophy:** Prefer simplicity. Every feature must earn its complexity. When in doubt, ship less and make it work perfectly.\n`;

  return p;
}

// ── GET /api/prompt/:project_id ──────────────────────────────────────────────
prompt.get('/:project_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string; completeness_score: number; mode: string }>();

  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fieldsResult = await c.env.DB.prepare(
    'SELECT * FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all();

  const fieldsMap: Record<string, string> = {};
  for (const f of fieldsResult.results as Array<{ section_key: string; field_key: string; value: string }>) {
    fieldsMap[f.field_key] = f.value || '';
  }

  return c.json({
    success: true,
    data: {
      session,
      fields: fieldsMap,
      sections: ALL_SECTIONS,
      completeness_score: session.completeness_score
    }
  });
});

// ── PUT /api/prompt/:project_id/field ────────────────────────────────────────
prompt.put('/:project_id/field', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { section_key, field_key, value } = await c.req.json();

  if (!section_key || !field_key) {
    return c.json({ success: false, error: 'section_key and field_key required' }, 400);
  }

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fieldId = generateId('pf');
  const isComplete = fieldIsFilled(field_key, value) ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO prompt_fields (id, session_id, section_key, field_key, value, is_complete)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, field_key) DO UPDATE SET
       value = excluded.value,
       is_complete = excluded.is_complete,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(fieldId, session.id, section_key, field_key, value || '', isComplete).run();

  // Recalculate completeness (core fields only)
  const allFields = await c.env.DB.prepare(
    'SELECT field_key, value FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all<{ field_key: string; value: string }>();

  const fieldsMap: Record<string, string> = {};
  for (const f of allFields.results) fieldsMap[f.field_key] = f.value || '';

  const score = calculateCompleteness(fieldsMap);

  await c.env.DB.prepare(
    `UPDATE prompt_sessions SET completeness_score = ?, last_section = ?, autosave_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(score, section_key, session.id).run();

  await c.env.DB.prepare(
    'UPDATE projects SET readiness_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, projectId).run();

  return c.json({ success: true, data: { completeness_score: score, field_saved: true } });
});

// ── PUT /api/prompt/:project_id/bulk ─────────────────────────────────────────
prompt.put('/:project_id/bulk', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { fields } = await c.req.json<{ fields: Record<string, { section_key: string; value: string }> }>();

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const statements = [];
  const fieldsMap: Record<string, string> = {};

  for (const [field_key, { section_key, value }] of Object.entries(fields)) {
    const isComplete = fieldIsFilled(field_key, value) ? 1 : 0;
    fieldsMap[field_key] = value || '';
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO prompt_fields (id, session_id, section_key, field_key, value, is_complete)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, field_key) DO UPDATE SET
           value = excluded.value, is_complete = excluded.is_complete, updated_at = CURRENT_TIMESTAMP`
      ).bind(generateId('pf'), session.id, section_key, field_key, value || '', isComplete)
    );
  }

  if (statements.length > 0) await c.env.DB.batch(statements);

  const score = calculateCompleteness(fieldsMap);
  await c.env.DB.prepare(
    'UPDATE prompt_sessions SET completeness_score = ?, autosave_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, session.id).run();
  await c.env.DB.prepare(
    'UPDATE projects SET readiness_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, projectId).run();

  return c.json({ success: true, data: { completeness_score: score, saved_count: statements.length } });
});

// ── POST /api/prompt/:project_id/ai-assist ────────────────────────────────────
prompt.post('/:project_id/ai-assist', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { section_key, field_key, model_id } = await c.req.json();

  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fields = await c.env.DB.prepare(
    'SELECT field_key, value FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all<{ field_key: string; value: string }>();

  const fieldsMap: Record<string, string> = {};
  for (const f of fields.results) fieldsMap[f.field_key] = f.value || '';

  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < 2) {
    return c.json({ success: false, error: 'Insufficient coins. AI assist costs 2 coins.' }, 402);
  }

  const aiService = new AIService(c.env, c.env.DB);
  const selectedModel = model_id || project.active_model_id || 'model_gpt4o_mini';

  const result = await aiService.processIntent({
    intent: 'complete_prompt_field',
    userId: user.id,
    projectId,
    sessionId: session.id,
    modelId: selectedModel,
    context: {
      field_key,
      section_key,
      current_value: fieldsMap[field_key] || '',
      app_name: fieldsMap['app_name'] || '',
      category: fieldsMap['category'] || '',
      audience: fieldsMap['audience'] || '',
      problem: fieldsMap['problem_statement'] || ''
    }
  });

  if (!result.success) return c.json({ success: false, error: result.error }, 500);

  const { CoinService: CS } = await import('../services/coin.service');
  const cs = new CS(c.env.DB);
  await cs.debit(user.id, 2, 'spend', `AI assist: ${field_key}`, projectId, 'ai_assist');

  return c.json({ success: true, data: { suggestion: result.output, coins_spent: 2 } });
});

// ── GET /api/prompt/:project_id/export ────────────────────────────────────────
prompt.get('/:project_id/export', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first<{ id: string; name: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string; completeness_score: number }>();
  if (!session) return c.json({ success: false, error: 'No session found' }, 404);

  const fieldsResult = await c.env.DB.prepare(
    'SELECT field_key, value FROM prompt_fields WHERE session_id = ? AND value IS NOT NULL AND value != ?'
  ).bind(session.id, '').all<{ field_key: string; value: string }>();

  const fieldsMap: Record<string, string> = {};
  for (const f of fieldsResult.results) fieldsMap[f.field_key] = f.value || '';

  const promptText = buildStructuredPrompt(fieldsMap, project.name, session.completeness_score);

  return c.json({
    success: true,
    data: {
      prompt_text: promptText,
      completeness_score: session.completeness_score,
      project_name: project.name
    }
  });
});

export default prompt;
