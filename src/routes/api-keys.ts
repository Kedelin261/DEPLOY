// DEPLOY Platform — Public API Key Management
// Pro/Team users can generate API keys for headless access to the build system.
// Keys are stored hashed; only the raw key is shown once at creation.
//
// Routes:
//   GET    /api/keys          — list user's API keys (no secret shown)
//   POST   /api/keys          — create a new API key
//   DELETE /api/keys/:key_id  — revoke a key
//   POST   /api/keys/verify   — validate a key (internal / machine-to-machine)

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const apiKeys = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Plans that are allowed to use API keys
const API_KEY_PLANS = new Set(['pro', 'team', 'enterprise']);
const MAX_KEYS_PER_USER = 5;

// ── Hash the raw key using SHA-256 ────────────────────────────────────────────
async function hashApiKey(rawKey: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Generate a cryptographically random API key ───────────────────────────────
function generateRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `dk_live_${hex}`;  // prefix: deploy key live
}

// ── GET /api/keys — list all API keys for user ────────────────────────────────
apiKeys.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  if (!API_KEY_PLANS.has(user.plan_slug)) {
    return c.json({
      success: false,
      error: 'API keys are available on Pro and Team plans.',
      data: { upgrade_required: true }
    }, 403);
  }

  const keys = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, last_used_at, created_at, is_active
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(user.id).all();

  return c.json({ success: true, data: keys.results });
});

// ── POST /api/keys — create a new API key ────────────────────────────────────
apiKeys.post('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  if (!API_KEY_PLANS.has(user.plan_slug)) {
    return c.json({
      success: false,
      error: 'API keys are available on Pro and Team plans. Upgrade to generate keys.',
      data: { upgrade_required: true }
    }, 403);
  }

  const { name } = await c.req.json();
  if (!name?.trim()) {
    return c.json({ success: false, error: 'A key name is required (e.g. "CI Pipeline")' }, 400);
  }

  // Enforce max keys limit
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM api_keys WHERE user_id = ? AND is_active = 1'
  ).bind(user.id).first<{ total: number }>();
  if ((count?.total || 0) >= MAX_KEYS_PER_USER) {
    return c.json({ success: false, error: `You can have at most ${MAX_KEYS_PER_USER} active API keys. Revoke one first.` }, 409);
  }

  const rawKey = generateRawKey();
  const keyHash = await hashApiKey(rawKey);
  const keyId = generateId('ak');
  const keyPrefix = rawKey.slice(0, 14) + '…';  // show first 14 chars as prefix

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).bind(keyId, user.id, name.trim(), keyHash, keyPrefix).run();

  // Audit log
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id)
     VALUES (?, ?, 'api_key_created', 'api_key', ?)`
  ).bind(generateId('log'), user.id, keyId).run().catch(() => {});

  return c.json({
    success: true,
    data: {
      id: keyId,
      name: name.trim(),
      key: rawKey,        // ← shown ONCE — never stored in plaintext
      key_prefix: keyPrefix,
      created_at: new Date().toISOString(),
    },
    message: 'API key created. Copy it now — it will not be shown again.'
  }, 201);
});

// ── DELETE /api/keys/:key_id — revoke a key ──────────────────────────────────
apiKeys.delete('/:key_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const keyId = c.req.param('key_id');

  const key = await c.env.DB.prepare(
    'SELECT id FROM api_keys WHERE id = ? AND user_id = ?'
  ).bind(keyId, user.id).first();
  if (!key) return c.json({ success: false, error: 'API key not found' }, 404);

  await c.env.DB.prepare(
    'UPDATE api_keys SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(keyId).run();

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id)
     VALUES (?, ?, 'api_key_revoked', 'api_key', ?)`
  ).bind(generateId('log'), user.id, keyId).run().catch(() => {});

  return c.json({ success: true, message: 'API key revoked' });
});

// ── POST /api/keys/verify — validate a key (used by external services) ────────
apiKeys.post('/verify', async (c) => {
  const { api_key } = await c.req.json();
  if (!api_key) return c.json({ valid: false, error: 'api_key required' }, 400);

  const keyHash = await hashApiKey(api_key);
  const record = await c.env.DB.prepare(
    `SELECT ak.id, ak.user_id, ak.name, u.email, u.role,
            m.plan_id, p.slug as plan_slug
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id AND u.status = 'active'
     JOIN memberships m ON m.user_id = u.id
     JOIN plans p ON p.id = m.plan_id
     WHERE ak.key_hash = ? AND ak.is_active = 1`
  ).bind(keyHash).first<{ id: string; user_id: string; name: string; email: string; role: string; plan_slug: string }>();

  if (!record) {
    return c.json({ valid: false, error: 'Invalid or revoked API key' }, 401);
  }

  // Update last_used_at
  await c.env.DB.prepare(
    'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(record.id).run().catch(() => {});

  return c.json({
    valid: true,
    data: {
      key_id: record.id,
      user_id: record.user_id,
      email: record.email,
      plan_slug: record.plan_slug,
      role: record.role,
    }
  });
});

export default apiKeys;
