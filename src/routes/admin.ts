// DEPLOY Platform - Admin Routes

import { Hono } from 'hono';
import { authMiddleware, adminMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import type { Bindings, Variables } from '../types';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

admin.use('/*', authMiddleware(), adminMiddleware());

// GET /api/admin/stats
admin.get('/stats', async (c) => {
  const [users, projects, builds, revenue] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN created_at > datetime('now', '-30 days') THEN 1 ELSE 0 END) as last_30 FROM users`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'built' THEN 1 ELSE 0 END) as built FROM projects`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed FROM build_jobs`).first(),
    c.env.DB.prepare(`SELECT SUM(amount_cents) as total FROM billing_events WHERE status = 'completed'`).first()
  ]);

  return c.json({ success: true, data: { users, projects, builds, revenue } });
});

// GET /api/admin/users
admin.get('/users', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const search = c.req.query('search') || '';
  const perPage = 20;
  const offset = (page - 1) * perPage;

  const users = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
            p.slug as plan_slug, w.balance as coin_balance
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id
     LEFT JOIN plans p ON p.id = m.plan_id
     LEFT JOIN coin_wallets w ON w.user_id = u.id
     WHERE u.email LIKE ? OR u.name LIKE ?
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(`%${search}%`, `%${search}%`, perPage, offset).all();

  return c.json({ success: true, data: users.results });
});

// POST /api/admin/coins/adjust
admin.post('/coins/adjust', async (c) => {
  const admin = c.get('user')!;
  const { user_id, amount, reason } = await c.req.json();

  if (!user_id || !amount || !reason) {
    return c.json({ success: false, error: 'user_id, amount, and reason required' }, 400);
  }

  const coinService = new CoinService(c.env.DB);
  
  if (amount > 0) {
    await coinService.credit(user_id, amount, 'admin_adjust', `Admin grant: ${reason}`, admin.id, 'admin');
  } else {
    await coinService.debit(user_id, Math.abs(amount), 'admin_adjust', `Admin deduction: ${reason}`, admin.id, 'admin');
  }

  await c.env.DB.prepare(
    'INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(generateId('aa'), admin.id, user_id, 'coin_adjustment', reason, JSON.stringify({ amount })).run();

  return c.json({ success: true, message: `${Math.abs(amount)} coins ${amount > 0 ? 'added to' : 'removed from'} user account` });
});

// PUT /api/admin/users/:id/status
admin.put('/users/:id/status', async (c) => {
  const adminUser = c.get('user')!;
  const userId = c.req.param('id');
  const { status, reason } = await c.req.json();

  if (!['active', 'suspended'].includes(status)) {
    return c.json({ success: false, error: 'Invalid status' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE users SET status = ? WHERE id = ?'
  ).bind(status, userId).run();

  await c.env.DB.prepare(
    'INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason) VALUES (?, ?, ?, ?, ?)'
  ).bind(generateId('aa'), adminUser.id, userId, `user_${status}`, reason || null).run();

  return c.json({ success: true, message: `User ${status}` });
});

// GET /api/admin/feature-flags
admin.get('/feature-flags', async (c) => {
  const flags = await c.env.DB.prepare('SELECT * FROM feature_flags ORDER BY key ASC').all();
  return c.json({ success: true, data: flags.results });
});

// PUT /api/admin/feature-flags/:key
admin.put('/feature-flags/:key', async (c) => {
  const admin = c.get('user')!;
  const key = c.req.param('key');
  const { value } = await c.req.json();

  await c.env.DB.prepare(
    'UPDATE feature_flags SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
  ).bind(String(value), admin.id, key).run();

  return c.json({ success: true, message: 'Feature flag updated' });
});

// GET /api/admin/build-jobs
admin.get('/build-jobs', async (c) => {
  const status = c.req.query('status');
  const query = status
    ? `SELECT bj.*, u.email, u.name FROM build_jobs bj JOIN users u ON u.id = bj.user_id WHERE bj.status = ? ORDER BY bj.created_at DESC LIMIT 50`
    : `SELECT bj.*, u.email, u.name FROM build_jobs bj JOIN users u ON u.id = bj.user_id ORDER BY bj.created_at DESC LIMIT 50`;
  
  const jobs = status
    ? await c.env.DB.prepare(query).bind(status).all()
    : await c.env.DB.prepare(query).all();

  return c.json({ success: true, data: jobs.results });
});

export default admin;
