// DEPLOY Platform - Vault & Coins Routes
// All Stripe calls go through StripeService (server-side only).
// Frontend never touches API keys directly.

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import { StripeService } from '../services/stripe.service';
import { ResendService } from '../services/resend.service';
import type { Bindings, Variables } from '../types';

const vault = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── GET /api/vault ────────────────────────────────────────────────────────
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

  // Usage this month
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

// ─── GET /api/vault/ledger ─────────────────────────────────────────────────
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

// ─── POST /api/vault/checkout ──────────────────────────────────────────────
// Creates a Stripe Checkout Session and returns the redirect URL.
// Frontend redirects the user to this URL — no secrets leave the server.
vault.post('/checkout', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { package_id } = await c.req.json();

  const pkg = await c.env.DB.prepare(
    'SELECT * FROM coin_packages WHERE id = ? AND is_active = 1'
  ).bind(package_id).first<{
    id: string; name: string; coins: number; bonus_coins: number;
    price_cents: number; stripe_price_id: string;
  }>();

  if (!pkg) return c.json({ success: false, error: 'Package not found' }, 404);

  const appUrl = c.env.APP_URL || 'http://localhost:3000';

  try {
    const stripe = new StripeService(c.env);
    const { sessionId, url } = await stripe.createCoinCheckoutSession({
      userId: user.id,
      userEmail: user.email,
      packageId: pkg.id,
      packageName: pkg.name,
      priceCents: pkg.price_cents,
      stripePriceId: pkg.stripe_price_id || undefined,
      coins: pkg.coins,
      bonusCoins: pkg.bonus_coins || 0,
      successUrl: `${appUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/?payment=cancelled`,
    });

    // Record a pending billing event
    await c.env.DB.prepare(
      `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status, external_id)
       VALUES (?, ?, 'coin_purchase', ?, ?, 'pending', ?)`
    ).bind(
      generateId('bill'), user.id, pkg.price_cents,
      `${pkg.name} — ${pkg.coins + (pkg.bonus_coins || 0)} coins`,
      sessionId
    ).run().catch(() => {/* billing_events may not have external_id col yet — safe to ignore */});

    return c.json({ success: true, data: { checkout_url: url, session_id: sessionId } });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    // Graceful fallback for dev/test environments without live Stripe
    return c.json({
      success: false,
      error: 'Payment processing temporarily unavailable. Please try again later.',
      dev_note: c.env.ENVIRONMENT === 'development' ? String(err) : undefined,
    }, 503);
  }
});

// ─── POST /api/vault/purchase (legacy / simulated — dev only) ──────────────
// Kept for local dev without Stripe configured. Production uses /checkout.
vault.post('/purchase', authMiddleware(), async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ success: false, error: 'Use /api/vault/checkout for purchases' }, 400);
  }

  const user = c.get('user')!;
  const { package_id } = await c.req.json();

  const pkg = await c.env.DB.prepare(
    'SELECT * FROM coin_packages WHERE id = ? AND is_active = 1'
  ).bind(package_id).first<{
    id: string; name: string; coins: number; bonus_coins: number; price_cents: number;
  }>();

  if (!pkg) return c.json({ success: false, error: 'Package not found' }, 404);

  const totalCoins = pkg.coins + (pkg.bonus_coins || 0);
  const coinService = new CoinService(c.env.DB);

  await coinService.credit(
    user.id, totalCoins, 'purchase',
    `[DEV] Purchased ${pkg.name}: ${pkg.coins} coins${pkg.bonus_coins > 0 ? ` + ${pkg.bonus_coins} bonus` : ''}`,
    generateId('purchase'), 'coin_purchase'
  );

  await c.env.DB.prepare(
    `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status)
     VALUES (?, ?, 'coin_purchase', ?, ?, 'completed')`
  ).bind(generateId('bill'), user.id, pkg.price_cents, `[DEV] ${pkg.name} - ${totalCoins} coins`).run();

  const wallet = await c.env.DB.prepare(
    'SELECT balance FROM coin_wallets WHERE user_id = ?'
  ).bind(user.id).first<{ balance: number }>();

  return c.json({
    success: true,
    data: { coins_added: totalCoins, new_balance: wallet?.balance || 0 },
    message: `[DEV] ${totalCoins} coins added to your vault!`
  });
});

// ─── POST /api/vault/grant ─────────────────────────────────────────────────
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

// ─── GET /api/vault/portal ─────────────────────────────────────────────────
// Redirect user to Stripe Customer Portal to manage subscription.
vault.get('/portal', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const appUrl = c.env.APP_URL || 'http://localhost:3000';

  // Look up Stripe customer ID
  const billing = await c.env.DB.prepare(
    'SELECT stripe_customer_id FROM user_billing WHERE user_id = ?'
  ).bind(user.id).first<{ stripe_customer_id: string }>().catch(() => null);

  if (!billing?.stripe_customer_id) {
    return c.json({ success: false, error: 'No active subscription found' }, 404);
  }

  try {
    const stripe = new StripeService(c.env);
    const { url } = await stripe.createPortalSession({
      customerId: billing.stripe_customer_id,
      returnUrl: appUrl,
    });
    return c.json({ success: true, data: { portal_url: url } });
  } catch (err) {
    console.error('Stripe portal error:', err);
    return c.json({ success: false, error: 'Could not open billing portal' }, 500);
  }
});

export default vault;
