// DEPLOY Platform - Vault & Coins Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import type { Bindings, Variables } from '../types';

const vault = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/vault - Full vault summary
vault.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  const [wallet, membership, ledger, holds, packages] = await Promise.all([
    c.env.DB.prepare(
      `SELECT w.*, p.name as plan_name, p.slug as plan_slug, p.monthly_coins
       FROM coin_wallets w
       LEFT JOIN memberships m ON m.user_id = w.user_id
       LEFT JOIN plans p ON p.id = m.plan_id
       WHERE w.user_id = ?`
    ).bind(user.id).first(),

    c.env.DB.prepare(
      `SELECT m.*, p.name as plan_name, p.slug, p.monthly_coins, p.price_cents,
              p.max_projects, p.max_deployments, p.max_uploads
       FROM memberships m JOIN plans p ON p.id = m.plan_id WHERE m.user_id = ?`
    ).bind(user.id).first(),

    c.env.DB.prepare(
      `SELECT * FROM coin_ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
    ).bind(user.id).all(),

    c.env.DB.prepare(
      `SELECT * FROM coin_holds WHERE user_id = ? AND status = 'active'`
    ).bind(user.id).all(),

    c.env.DB.prepare('SELECT * FROM coin_packages WHERE is_active = 1 ORDER BY coins ASC').all()
  ]);

  // Calculate stats
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const usageThisMonth = await c.env.DB.prepare(
    `SELECT SUM(ABS(amount)) as total FROM coin_ledger_entries
     WHERE user_id = ? AND type IN ('spend','hold') AND created_at > ?`
  ).bind(user.id, thirtyDaysAgo).first<{ total: number }>();

  return c.json({
    success: true,
    data: {
      wallet,
      membership,
      recent_transactions: ledger.results,
      active_holds: holds.results,
      packages: packages.results,
      usage_this_month: usageThisMonth?.total || 0
    }
  });
});

// GET /api/vault/ledger - Full transaction history
vault.get('/ledger', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const page = parseInt(c.req.query('page') || '1');
  const perPage = 20;
  const coinService = new CoinService(c.env.DB);
  const { items, total } = await coinService.getLedger(user.id, page, perPage);

  return c.json({
    success: true,
    data: {
      items, total, page, per_page: perPage,
      has_more: page * perPage < total
    }
  });
});

// POST /api/vault/purchase - Purchase coins
vault.post('/purchase', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { package_id } = await c.req.json();

  const pkg = await c.env.DB.prepare(
    'SELECT * FROM coin_packages WHERE id = ? AND is_active = 1'
  ).bind(package_id).first<{
    id: string; name: string; coins: number; bonus_coins: number; price_cents: number; stripe_price_id: string;
  }>();

  if (!pkg) return c.json({ success: false, error: 'Package not found' }, 404);

  // In production: initiate Stripe payment intent
  // For MVP: simulate successful purchase
  const totalCoins = pkg.coins + pkg.bonus_coins;
  const coinService = new CoinService(c.env.DB);

  await coinService.credit(
    user.id, totalCoins, 'purchase',
    `Purchased ${pkg.name}: ${pkg.coins} coins${pkg.bonus_coins > 0 ? ` + ${pkg.bonus_coins} bonus` : ''}`,
    generateId('purchase'), 'coin_purchase'
  );

  // Log billing event
  await c.env.DB.prepare(
    `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status)
     VALUES (?, ?, 'coin_purchase', ?, ?, 'completed')`
  ).bind(generateId('bill'), user.id, pkg.price_cents, `${pkg.name} - ${totalCoins} coins`).run();

  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();

  return c.json({
    success: true,
    data: { coins_added: totalCoins, new_balance: wallet?.balance || 0 },
    message: `${totalCoins} coins added to your vault!`
  });
});

// POST /api/vault/grant - Process monthly grant (called by system/cron)
vault.post('/grant', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const coinService = new CoinService(c.env.DB);
  const granted = await coinService.processMonthlyGrant(user.id, user.plan_slug);

  if (granted === 0) {
    return c.json({ success: false, message: 'No grant available at this time' });
  }

  return c.json({
    success: true,
    data: { coins_granted: granted },
    message: `${granted} coins added from your monthly ${user.plan_slug} grant!`
  });
});

export default vault;
