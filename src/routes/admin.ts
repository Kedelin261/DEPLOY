// DEPLOY Platform - Admin Routes
// All logic flows through the Intent Layer per architecture rules.
// No direct Action Layer rewrites — only Intent → query → response.

import { Hono } from 'hono';
import { authMiddleware, adminMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import type { Bindings, Variables } from '../types';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

admin.use('/*', authMiddleware(), adminMiddleware());

// ============================================================
// INTENT: Get platform overview stats (the "command centre")
// ============================================================
admin.get('/stats', async (c) => {
  const [users, projects, builds, revenue, coins, logins] = await Promise.all([
    c.env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN created_at > datetime('now','-30 days') THEN 1 ELSE 0 END) as last_30d,
        SUM(CASE WHEN created_at > datetime('now','-7 days')  THEN 1 ELSE 0 END) as last_7d,
        SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended
      FROM users`).first(),

    c.env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='built'   THEN 1 ELSE 0 END) as built,
        SUM(CASE WHEN status='draft'   THEN 1 ELSE 0 END) as draft,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending
      FROM projects`).first(),

    c.env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) as running
      FROM build_jobs`).first(),

    // Revenue: total paid, last 30d, last 7d
    c.env.DB.prepare(`
      SELECT
        COALESCE(SUM(amount_cents),0)                                                               as total_cents,
        COALESCE(SUM(CASE WHEN created_at > datetime('now','-30 days') THEN amount_cents ELSE 0 END),0) as last_30d_cents,
        COALESCE(SUM(CASE WHEN created_at > datetime('now','-7 days')  THEN amount_cents ELSE 0 END),0) as last_7d_cents,
        COUNT(*)                                                                                    as total_transactions
      FROM billing_events WHERE status='completed'`).first(),

    // Platform-wide coin economy
    c.env.DB.prepare(`
      SELECT
        COALESCE(SUM(w.balance),0)       as total_coins_held,
        COALESCE(SUM(w.lifetime_earned),0)  as total_coins_ever_issued,
        COALESCE(SUM(w.lifetime_spent),0)   as total_coins_spent,
        COUNT(w.id)                      as total_wallets
      FROM coin_wallets w`).first(),

    // Login events in last 30d (from audit_logs or sessions)
    c.env.DB.prepare(`
      SELECT COUNT(*) as total_logins_30d
      FROM sessions
      WHERE created_at > datetime('now','-30 days')`).first(),
  ]);

  return c.json({
    success: true,
    data: { users, projects, builds, revenue, coins, logins }
  });
});

// ============================================================
// INTENT: List all users with full detail
// ============================================================
admin.get('/users', async (c) => {
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const search = c.req.query('search') || '';
  const plan   = c.req.query('plan')   || '';
  const status = c.req.query('status') || '';
  const limit  = 25;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const binds: any[] = [];

  if (search) {
    where += ' AND (u.email LIKE ? OR u.name LIKE ?)';
    binds.push(`%${search}%`, `%${search}%`);
  }
  if (status) { where += ' AND u.status = ?'; binds.push(status); }
  if (plan)   { where += ' AND p.slug = ?';   binds.push(plan);   }

  binds.push(limit, offset);

  const users = await c.env.DB.prepare(`
    SELECT
      u.id, u.email, u.name, u.role, u.status, u.created_at,
      p.slug   as plan,
      p.name   as plan_name,
      w.balance          as coins,
      w.lifetime_earned  as coins_ever_earned,
      w.lifetime_spent   as coins_spent,
      (SELECT COUNT(*) FROM projects   WHERE user_id = u.id)   as project_count,
      (SELECT COUNT(*) FROM build_jobs WHERE user_id = u.id)   as build_count,
      (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) as last_login
    FROM users u
    LEFT JOIN memberships  m ON m.user_id = u.id
    LEFT JOIN plans        p ON p.id      = m.plan_id
    LEFT JOIN coin_wallets w ON w.user_id = u.id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  const countRes = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM users u LEFT JOIN memberships m ON m.user_id=u.id LEFT JOIN plans p ON p.id=m.plan_id ${where.replace('LIMIT ? OFFSET ?','')}`
  ).bind(...binds.slice(0, -2)).first() as any;

  return c.json({ success: true, data: users.results, total: countRes?.n ?? 0, page, limit });
});

// ============================================================
// INTENT: Full platform coin ledger (all users, all events)
// ============================================================
admin.get('/coins/ledger', async (c) => {
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const type   = c.req.query('type')    || '';
  const userId = c.req.query('user_id') || '';
  const limit  = 50;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const binds: any[] = [];
  if (type)   { where += ' AND e.entry_type = ?'; binds.push(type); }
  if (userId) { where += ' AND e.user_id = ?';    binds.push(userId); }
  binds.push(limit, offset);

  const entries = await c.env.DB.prepare(`
    SELECT
      e.id, e.user_id, u.email, u.name,
      e.entry_type, e.amount, e.balance_after, e.description,
      e.reference_type, e.reference_id,
      e.created_at
    FROM coin_ledger_entries e
    JOIN users u ON u.id = e.user_id
    ${where}
    ORDER BY e.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return c.json({ success: true, data: entries.results });
});

// ============================================================
// INTENT: All revenue / billing transactions
// ============================================================
admin.get('/revenue', async (c) => {
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit  = 50;
  const offset = (page - 1) * limit;

  const txns = await c.env.DB.prepare(`
    SELECT
      b.id, b.user_id, u.email, u.name,
      b.event_type, b.amount_cents, b.currency, b.status,
      b.stripe_payment_intent_id,
      b.coins_granted,
      b.description,
      b.created_at
    FROM billing_events b
    JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  return c.json({ success: true, data: txns.results });
});

// ============================================================
// INTENT: Audit log — every significant action across all users
// ============================================================
admin.get('/audit-log', async (c) => {
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const action = c.req.query('action') || '';
  const userId = c.req.query('user_id') || '';
  const limit  = 50;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const binds: any[] = [];
  if (action) { where += ' AND a.action LIKE ?'; binds.push(`%${action}%`); }
  if (userId) { where += ' AND a.user_id = ?'; binds.push(userId); }
  binds.push(limit, offset);

  const logs = await c.env.DB.prepare(`
    SELECT
      a.id, a.action, a.resource_type, a.resource_id,
      a.user_id,
      u.email  as user_email,
      u.name   as user_name,
      a.ip_address, a.new_value as metadata, a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return c.json({ success: true, data: logs.results });
});

// ============================================================
// INTENT: Login history (sessions table)
// ============================================================
admin.get('/logins', async (c) => {
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const userId = c.req.query('user_id') || '';
  const limit  = 50;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const binds: any[] = [];
  if (userId) { where += ' AND s.user_id = ?'; binds.push(userId); }
  binds.push(limit, offset);

  const sessions = await c.env.DB.prepare(`
    SELECT
      s.id, s.user_id, u.email, u.name,
      u.role, u.status,
      s.created_at as login_at,
      s.expires_at,
      s.ip_address,
      s.user_agent
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return c.json({ success: true, data: sessions.results });
});

// ============================================================
// INTENT: All build jobs across platform
// ============================================================
admin.get('/builds', async (c) => {
  const status = c.req.query('status') || '';
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit  = 50;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const binds: any[] = [];
  if (status) { where += ' AND bj.status = ?'; binds.push(status); }
  binds.push(limit, offset);

  const jobs = await c.env.DB.prepare(`
    SELECT
      bj.id, bj.status, bj.model_id, bj.coins_held, bj.coins_charged,
      bj.created_at, bj.completed_at,
      bj.user_id, u.email, u.name,
      p.name as project_name
    FROM build_jobs bj
    JOIN users    u ON u.id  = bj.user_id
    JOIN projects p ON p.id  = bj.project_id
    ${where}
    ORDER BY bj.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return c.json({ success: true, data: jobs.results });
});

// ============================================================
// INTENT: Adjust coins for a specific user
// ============================================================
admin.post('/coins/adjust', async (c) => {
  const adminUser = c.get('user')!;
  const { user_id, amount, reason } = await c.req.json();

  if (!user_id || typeof amount !== 'number' || !reason) {
    return c.json({ success: false, error: 'user_id, amount (number), and reason required' }, 400);
  }

  const coinService = new CoinService(c.env.DB);

  if (amount > 0) {
    await coinService.credit(user_id, amount, 'admin_adjust', `Admin grant: ${reason}`, adminUser.id, 'admin');
  } else {
    await coinService.debit(user_id, Math.abs(amount), 'admin_adjust', `Admin deduction: ${reason}`, adminUser.id, 'admin');
  }

  await c.env.DB.prepare(
    `INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason, metadata)
     VALUES (?, ?, ?, 'coin_adjustment', ?, ?)`
  ).bind(generateId('aa'), adminUser.id, user_id, reason, JSON.stringify({ amount })).run();

  return c.json({ success: true, message: `${Math.abs(amount)} coins ${amount > 0 ? 'credited to' : 'debited from'} user` });
});

// ============================================================
// INTENT: Suspend / reactivate a user
// ============================================================
admin.put('/users/:id/status', async (c) => {
  const adminUser = c.get('user')!;
  const userId    = c.req.param('id');
  const { status, reason } = await c.req.json();

  if (!['active', 'suspended'].includes(status)) {
    return c.json({ success: false, error: 'status must be active or suspended' }, 400);
  }

  await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, userId).run();

  await c.env.DB.prepare(
    `INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(generateId('aa'), adminUser.id, userId, `user_${status}`, reason || null).run();

  return c.json({ success: true, message: `User ${status}` });
});

// ============================================================
// INTENT: Promote user to admin
// ============================================================
admin.put('/users/:id/role', async (c) => {
  const adminUser = c.get('user')!;
  const userId    = c.req.param('id');
  const { role }  = await c.req.json();

  if (!['user', 'admin'].includes(role)) {
    return c.json({ success: false, error: 'role must be user or admin' }, 400);
  }

  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, userId).run();

  await c.env.DB.prepare(
    `INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason)
     VALUES (?, ?, ?, 'role_change', ?)`
  ).bind(generateId('aa'), adminUser.id, userId, `Changed role to ${role}`).run();

  return c.json({ success: true, message: `User role updated to ${role}` });
});

// ============================================================
// INTENT: Feature flags
// ============================================================
admin.get('/feature-flags', async (c) => {
  const flags = await c.env.DB.prepare('SELECT * FROM feature_flags ORDER BY key ASC').all();
  return c.json({ success: true, data: flags.results });
});

admin.put('/feature-flags/:key', async (c) => {
  const adminUser = c.get('user')!;
  const key       = c.req.param('key');
  const { value } = await c.req.json();

  await c.env.DB.prepare(
    'UPDATE feature_flags SET value=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE key=?'
  ).bind(String(value), adminUser.id, key).run();

  return c.json({ success: true, message: 'Flag updated' });
});

export default admin;
