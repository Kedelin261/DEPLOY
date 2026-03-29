// DEPLOY Platform - Vault & Coins Routes
// All Stripe calls go through StripeService (server-side only).
// Frontend never touches secret keys directly.

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import { StripeService } from '../services/stripe.service';
import { ResendService } from '../services/resend.service';
import type { Bindings, Variables } from '../types';

const vault = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Helper: get or create Stripe customer ID for user ───────────────────────
async function ensureStripeCustomer(
  env: Bindings,
  userId: string,
  email: string,
  name: string
): Promise<string> {
  // Check if we already stored a customer ID
  const billing = await env.DB.prepare(
    'SELECT stripe_customer_id FROM user_billing WHERE user_id = ?'
  ).bind(userId).first<{ stripe_customer_id: string }>().catch(() => null);

  if (billing?.stripe_customer_id) return billing.stripe_customer_id;

  // Create a new Stripe customer
  const stripe = new StripeService(env);
  const customerId = await stripe.getOrCreateCustomer({ userId, email, name });

  // Persist it
  await env.DB.prepare(
    `INSERT INTO user_billing (id, user_id, stripe_customer_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = CURRENT_TIMESTAMP`
  ).bind(generateId('ubill'), userId, customerId).run();

  return customerId;
}

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

    c.env.DB.prepare(
      'SELECT * FROM coin_packages WHERE is_active = 1 ORDER BY coins ASC'
    ).all()
  ]);

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
    data: { items, total, page, per_page: perPage, has_more: page * perPage < total }
  });
});

// ─── GET /api/vault/payment-methods ───────────────────────────────────────
// Returns the user's saved cards from Stripe (never returns raw card numbers).
vault.get('/payment-methods', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  // First check our local DB cache
  const localMethods = await c.env.DB.prepare(
    `SELECT * FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC`
  ).bind(user.id).all<{
    id: string; stripe_payment_method_id: string; type: string;
    brand: string; last_four: string; exp_month: number; exp_year: number; is_default: number;
  }>();

  if (localMethods.results.length > 0) {
    return c.json({
      success: true,
      data: {
        methods: localMethods.results.map(m => ({
          id: m.id,
          stripe_id: m.stripe_payment_method_id,
          brand: m.brand,
          last4: m.last_four,
          exp_month: m.exp_month,
          exp_year: m.exp_year,
          is_default: m.is_default === 1,
        }))
      }
    });
  }

  // No local cache — check Stripe directly if customer exists
  const billing = await c.env.DB.prepare(
    'SELECT stripe_customer_id FROM user_billing WHERE user_id = ?'
  ).bind(user.id).first<{ stripe_customer_id: string }>().catch(() => null);

  if (!billing?.stripe_customer_id) {
    return c.json({ success: true, data: { methods: [] } });
  }

  try {
    const stripe = new StripeService(c.env);
    const methods = await stripe.listPaymentMethods(billing.stripe_customer_id);
    return c.json({ success: true, data: { methods } });
  } catch (err) {
    console.error('List payment methods error:', err);
    return c.json({ success: true, data: { methods: [] } });
  }
});

// ─── DELETE /api/vault/payment-methods/:pm_id ─────────────────────────────
vault.delete('/payment-methods/:pm_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const pmId = c.req.param('pm_id');

  // Verify ownership
  const method = await c.env.DB.prepare(
    'SELECT * FROM payment_methods WHERE id = ? AND user_id = ?'
  ).bind(pmId, user.id).first<{ stripe_payment_method_id: string }>().catch(() => null);

  const stripeId = method?.stripe_payment_method_id || (pmId.startsWith('pm_') ? pmId : null);
  if (!stripeId) return c.json({ success: false, error: 'Payment method not found' }, 404);

  try {
    const stripe = new StripeService(c.env);
    await stripe.detachPaymentMethod(stripeId);

    // Remove from local DB
    await c.env.DB.prepare(
      'DELETE FROM payment_methods WHERE user_id = ? AND stripe_payment_method_id = ?'
    ).bind(user.id, stripeId).run().catch(() => {});

    return c.json({ success: true, message: 'Card removed' });
  } catch (err) {
    console.error('Remove card error:', err);
    return c.json({ success: false, error: 'Failed to remove card' }, 500);
  }
});

// ─── POST /api/vault/setup-intent ─────────────────────────────────────────
// Returns a Stripe SetupIntent clientSecret so the frontend can collect
// card details using Stripe.js Elements — no payment taken yet.
vault.post('/setup-intent', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  const fullUser = await c.env.DB.prepare(
    'SELECT name FROM users WHERE id = ?'
  ).bind(user.id).first<{ name: string }>();

  try {
    const customerId = await ensureStripeCustomer(
      c.env, user.id, user.email, fullUser?.name || user.email
    );
    const stripe = new StripeService(c.env);
    const { clientSecret, setupIntentId } = await stripe.createSetupIntent(customerId);

    return c.json({ success: true, data: { client_secret: clientSecret, setup_intent_id: setupIntentId } });
  } catch (err) {
    console.error('SetupIntent error:', err);
    return c.json({ success: false, error: 'Could not initialise card setup' }, 500);
  }
});

// ─── POST /api/vault/save-payment-method ──────────────────────────────────
// Called after Stripe.js confirms the SetupIntent on the frontend.
// Stores the PaymentMethod details in our DB for display.
vault.post('/save-payment-method', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { payment_method_id, set_default } = await c.req.json();
  if (!payment_method_id) return c.json({ success: false, error: 'payment_method_id required' }, 400);

  try {
    const stripe = new StripeService(c.env);
    const card = await stripe.retrievePaymentMethod(payment_method_id);

    // If set_default, clear existing defaults
    if (set_default) {
      await c.env.DB.prepare(
        'UPDATE payment_methods SET is_default = 0 WHERE user_id = ?'
      ).bind(user.id).run().catch(() => {});
    }

    // Upsert into payment_methods table
    const isFirstCard = !(await c.env.DB.prepare(
      'SELECT id FROM payment_methods WHERE user_id = ? LIMIT 1'
    ).bind(user.id).first());

    await c.env.DB.prepare(
      `INSERT INTO payment_methods (id, user_id, stripe_payment_method_id, type, brand, last_four, exp_month, exp_year, is_default)
       VALUES (?, ?, ?, 'card', ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_payment_method_id) DO UPDATE SET
         brand = excluded.brand, last_four = excluded.last_four,
         exp_month = excluded.exp_month, exp_year = excluded.exp_year,
         is_default = excluded.is_default`
    ).bind(
      generateId('pm'), user.id, card.id,
      card.brand, card.last4, card.expMonth, card.expYear,
      (set_default || isFirstCard) ? 1 : 0
    ).run();

    // Attach PM to Stripe customer
    const billing = await c.env.DB.prepare(
      'SELECT stripe_customer_id FROM user_billing WHERE user_id = ?'
    ).bind(user.id).first<{ stripe_customer_id: string }>().catch(() => null);

    if (billing?.stripe_customer_id) {
      await stripeRequest_attach(c.env.STRIPE_SECRET_KEY, payment_method_id, billing.stripe_customer_id);
    }

    return c.json({
      success: true,
      data: { brand: card.brand, last4: card.last4, exp_month: card.expMonth, exp_year: card.expYear },
      message: 'Card saved successfully'
    });
  } catch (err) {
    console.error('Save PM error:', err);
    return c.json({ success: false, error: 'Failed to save card' }, 500);
  }
});

// ─── POST /api/vault/checkout ──────────────────────────────────────────────
// Two paths:
//   1. saved_card=true  → charge the saved card immediately (no redirect)
//   2. saved_card=false → create Stripe Checkout Session and return redirect URL
vault.post('/checkout', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { package_id, payment_method_id } = await c.req.json();

  const pkg = await c.env.DB.prepare(
    'SELECT * FROM coin_packages WHERE id = ? AND is_active = 1'
  ).bind(package_id).first<{
    id: string; name: string; coins: number; bonus_coins: number;
    price_cents: number; stripe_price_id: string;
  }>();

  if (!pkg) return c.json({ success: false, error: 'Package not found' }, 404);

  const appUrl = c.env.APP_URL || 'http://localhost:3000';
  const totalCoins = pkg.coins + (pkg.bonus_coins || 0);

  const fullUser = await c.env.DB.prepare(
    'SELECT name FROM users WHERE id = ?'
  ).bind(user.id).first<{ name: string }>();

  try {
    const stripe = new StripeService(c.env);

    // ── PATH 1: Saved card — charge immediately ────────────────────────────
    if (payment_method_id) {
      const customerId = await ensureStripeCustomer(
        c.env, user.id, user.email, fullUser?.name || user.email
      );

      const { paymentIntentId, status } = await stripe.chargePaymentMethod({
        customerId,
        paymentMethodId: payment_method_id,
        amountCents: pkg.price_cents,
        description: `DEPLOY Coins — ${pkg.name} (${totalCoins} coins)`,
        metadata: {
          deploy_user_id: user.id,
          deploy_package_id: pkg.id,
          deploy_total_coins: String(totalCoins),
        },
      });

      if (status === 'succeeded') {
        // Credit coins immediately
        const coinService = new CoinService(c.env.DB);
        const { newBalance } = await coinService.credit(
          user.id, totalCoins, 'purchase',
          `Purchased ${pkg.name}: ${totalCoins} coins`,
          paymentIntentId, 'stripe_payment_intent'
        );

        // Billing record
        await c.env.DB.prepare(
          `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status, external_id)
           VALUES (?, ?, 'coin_purchase', ?, ?, 'completed', ?)`
        ).bind(
          generateId('bill'), user.id, pkg.price_cents,
          `${pkg.name} — ${totalCoins} coins`, paymentIntentId
        ).run().catch(() => {});

        // Audit
        await c.env.DB.prepare(
          `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, metadata)
           VALUES (?, ?, 'coin_purchase_completed', 'payment_intent', ?, ?)`
        ).bind(
          generateId('log'), user.id, paymentIntentId,
          JSON.stringify({ totalCoins, packageId: pkg.id, method: 'saved_card' })
        ).run().catch(() => {});

        // Receipt email
        try {
          const resend = new ResendService(c.env);
          await resend.sendCoinReceipt({
            to: user.email,
            name: fullUser?.name || user.email,
            packageName: pkg.name,
            coinsAdded: totalCoins,
            newBalance,
            amountPaid: `$${(pkg.price_cents / 100).toFixed(2)}`,
          });
        } catch (emailErr) {
          console.error('Receipt email failed (non-fatal):', emailErr);
        }

        return c.json({
          success: true,
          data: { coins_added: totalCoins, new_balance: newBalance, payment_intent_id: paymentIntentId },
          message: `${totalCoins} coins added to your vault!`
        });
      }

      // PaymentIntent needs further action (3DS etc.) — fall through to Checkout
    }

    // ── PATH 2: No saved card — Stripe Checkout Session (redirect) ─────────
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

    await c.env.DB.prepare(
      `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status, external_id)
       VALUES (?, ?, 'coin_purchase', ?, ?, 'pending', ?)`
    ).bind(
      generateId('bill'), user.id, pkg.price_cents,
      `${pkg.name} — ${totalCoins} coins`, sessionId
    ).run().catch(() => {});

    return c.json({ success: true, data: { checkout_url: url, session_id: sessionId } });

  } catch (err) {
    console.error('Checkout error:', err);
    return c.json({
      success: false,
      error: 'Payment processing unavailable. Please try again.',
      dev_note: c.env.ENVIRONMENT === 'development' ? String(err) : undefined,
    }, 503);
  }
});

// ─── POST /api/vault/checkout-plan ────────────────────────────────────────
// Creates a Stripe Checkout Session for a subscription upgrade.
vault.post('/checkout-plan', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { plan_slug, stripe_price_id } = await c.req.json();

  if (!stripe_price_id) return c.json({ success: false, error: 'stripe_price_id required' }, 400);

  const plan = await c.env.DB.prepare(
    'SELECT * FROM plans WHERE slug = ? AND is_active = 1'
  ).bind(plan_slug).first<{ id: string; name: string; price_cents: number }>().catch(() => null);

  if (!plan) return c.json({ success: false, error: 'Plan not found' }, 404);

  const appUrl = c.env.APP_URL || 'http://localhost:3000';

  try {
    const stripe = new StripeService(c.env);
    const { sessionId, url } = await stripe.createSubscriptionCheckoutSession({
      userId: user.id,
      userEmail: user.email,
      planSlug: plan_slug,
      planName: plan.name,
      stripePriceId: stripe_price_id,
      successUrl: `${appUrl}/?plan_upgrade=success`,
      cancelUrl: `${appUrl}/?plan_upgrade=cancelled`,
    });

    return c.json({ success: true, data: { checkout_url: url, session_id: sessionId } });
  } catch (err) {
    console.error('Plan checkout error:', err);
    return c.json({ success: false, error: 'Payment processing unavailable' }, 503);
  }
});

// ─── POST /api/vault/purchase (dev-only simulated purchase) ───────────────
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
  const { newBalance } = await coinService.credit(
    user.id, totalCoins, 'purchase',
    `[DEV] Purchased ${pkg.name}: ${totalCoins} coins`,
    generateId('dev'), 'dev_purchase'
  );

  await c.env.DB.prepare(
    `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status)
     VALUES (?, ?, 'coin_purchase', ?, ?, 'completed')`
  ).bind(generateId('bill'), user.id, pkg.price_cents, `[DEV] ${pkg.name}`).run();

  return c.json({
    success: true,
    data: { coins_added: totalCoins, new_balance: newBalance },
    message: `[DEV] ${totalCoins} coins added!`
  });
});

// ─── POST /api/vault/grant ─────────────────────────────────────────────────
vault.post('/grant', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const coinService = new CoinService(c.env.DB);
  const granted = await coinService.processMonthlyGrant(user.id, user.plan_slug);

  if (granted === 0) return c.json({ success: false, message: 'No grant available at this time' });

  return c.json({
    success: true,
    data: { coins_granted: granted },
    message: `${granted} coins added from your ${user.plan_slug} plan!`
  });
});

// ─── GET /api/vault/portal ─────────────────────────────────────────────────
vault.get('/portal', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const appUrl = c.env.APP_URL || 'http://localhost:3000';

  const billing = await c.env.DB.prepare(
    'SELECT stripe_customer_id FROM user_billing WHERE user_id = ?'
  ).bind(user.id).first<{ stripe_customer_id: string }>().catch(() => null);

  if (!billing?.stripe_customer_id) {
    return c.json({ success: false, error: 'No billing profile found' }, 404);
  }

  try {
    const stripe = new StripeService(c.env);
    const { url } = await stripe.createPortalSession({
      customerId: billing.stripe_customer_id,
      returnUrl: appUrl,
    });
    return c.json({ success: true, data: { portal_url: url } });
  } catch (err) {
    console.error('Portal error:', err);
    return c.json({ success: false, error: 'Could not open billing portal' }, 500);
  }
});

export default vault;

// ─── Internal helper (attach PM to customer) ─────────────────────────────
async function stripeRequest_attach(apiKey: string, pmId: string, customerId: string): Promise<void> {
  await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}/attach`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `customer=${encodeURIComponent(customerId)}`,
  });
}
