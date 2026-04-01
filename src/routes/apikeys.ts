// DEPLOY Platform — Public API Keys Routes
// Available to Pro/Team users only.
// POST   /api/apikeys           — create a new API key
// GET    /api/apikeys           — list user's API keys (no secret shown)
// DELETE /api/apikeys/:id       — revoke an API key

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const apikeys = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const PRO_PLANS = ['pro', 'team'];
const MAX_KEYS = 10;

// ── SHA-256 key hash ──────────────────────────────────────────────────────────
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Generate a secure API key ─────────────────────────────────────────────────
function generateAPIKey(): { fullKey: string; prefix: string } {
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const prefix = `dpk_live_${randomPart.slice(0, 8)}`;
  const fullKey = `dpk_live_${randomPart}`;
  return { fullKey, prefix };
}

// POST /api/apikeys — create key (Pro/Team only)
apikeys.post('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  // Plan gate
  if (!PRO_PLANS.includes(user.plan_slug)) {
    return c.json({
      success: false,
      error: 'API key access requires a Pro or Team plan.',
      upgrade_url: '/account#upgrade'
    }, 403);
  }

  // Limit
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM api_keys WHERE user_id = ? AND is_active = 1'
  ).bind(user.id).first<{ total: number }>();
  if ((count?.total ?? 0) >= MAX_KEYS) {
    return c.json({ success: false, error: `Maximum of ${MAX_KEYS} active API keys allowed.` }, 429);
  }

  const { name, scopes, expires_in_days } = await c.req.json();
  if (!name?.trim()) return c.json({ success: false, error: 'Key name is required' }, 400);

  const validScopes = ['build:read', 'build:write', 'project:read', 'project:write', 'deploy:write'];
  const requestedScopes: string[] = Array.isArray(scopes) ? scopes : ['build:read', 'build:write'];
  const invalidScopes = requestedScopes.filter(s => !validScopes.includes(s));
  if (invalidScopes.length) {
    return c.json({ success: false, error: `Invalid scopes: ${invalidScopes.join(', ')}` }, 400);
  }

  const { fullKey, prefix } = generateAPIKey();
  const keyHash = await sha256(fullKey);
  const keyId = generateId('apk');

  const expiresAt = expires_in_days
    ? new Date(Date.now() + parseInt(expires_in_days) * 86400000).toISOString()
    : null;

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, key_prefix, key_hash, name, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(keyId, user.id, prefix, keyHash, name.trim(), JSON.stringify(requestedScopes), expiresAt).run();

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id)
     VALUES (?, ?, 'api_key_created', 'api_key', ?)`
  ).bind(generateId('log'), user.id, keyId).run().catch(() => {});

  // Only time the full key is returned — not stored anywhere
  return c.json({
    success: true,
    data: {
      id: keyId,
      name: name.trim(),
      key: fullKey,        // SHOWN ONCE — user must save it
      prefix,
      scopes: requestedScopes,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    },
    message: 'Save this key — it will not be shown again.'
  }, 201);
});

// GET /api/apikeys — list (no secrets shown)
apikeys.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  const keys = await c.env.DB.prepare(
    `SELECT id, key_prefix, name, scopes, last_used_at, expires_at, is_active, created_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(user.id).all();

  const parsed = keys.results.map(k => ({
    ...(k as Record<string, unknown>),
    scopes: (() => {
      try { return JSON.parse((k as { scopes: string }).scopes); } catch { return []; }
    })()
  }));

  return c.json({ success: true, data: parsed });
});

// DELETE /api/apikeys/:id — revoke
apikeys.delete('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const keyId = c.req.param('id');

  const result = await c.env.DB.prepare(
    `UPDATE api_keys SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`
  ).bind(keyId, user.id).run();

  if (!result.meta.changes) {
    return c.json({ success: false, error: 'API key not found' }, 404);
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id)
     VALUES (?, ?, 'api_key_revoked', 'api_key', ?)`
  ).bind(generateId('log'), user.id, keyId).run().catch(() => {});

  return c.json({ success: true, message: 'API key revoked' });
});

// ── Middleware helper: validate API key from Authorization header ──────────────
// Usage: import { validateAPIKey } from './apikeys'
export async function validateAPIKey(
  authHeader: string | undefined,
  db: D1Database
): Promise<{ user_id: string; scopes: string[] } | null> {
  if (!authHeader?.startsWith('Bearer dpk_live_')) return null;
  const key = authHeader.slice(7);
  const hash = await sha256(key);

  const row = await db.prepare(
    `SELECT user_id, scopes, expires_at, is_active FROM api_keys WHERE key_hash = ?`
  ).bind(hash).first<{ user_id: string; scopes: string; expires_at: string | null; is_active: number }>();

  if (!row || !row.is_active) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Update last used
  db.prepare(
    `UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?`
  ).bind(hash).run().catch(() => {});

  let scopes: string[] = [];
  try { scopes = JSON.parse(row.scopes); } catch { /* */ }

  return { user_id: row.user_id, scopes };
}

export default apikeys;
