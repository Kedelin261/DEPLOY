// DEPLOY Platform - Stripe Webhook Handler
// IMPORTANT: This route must receive the RAW body (not parsed JSON) for signature verification.
// All coin grants and billing records are processed here after Stripe confirms payment.

import { Hono } from 'hono';
import { StripeService } from '../services/stripe.service';
import { ResendService } from '../services/resend.service';
import { CoinService } from '../services/coin.service';
import { generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const stripeWebhook = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /api/webhooks/stripe
stripeWebhook.post('/', async (c) => {
  const signature = c.req.header('stripe-signature') || '';
  const rawBody = await c.req.text();

  if (!signature) {
    console.error('[Webhook] Missing Stripe-Signature header');
    return c.json({ error: 'Missing signature' }, 400);
  }

  let event: Awaited<ReturnType<StripeService['verifyWebhook']>>;
  try {
    const stripe = new StripeService(c.env);
    event = await stripe.verifyWebhook(rawBody, signature);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  console.log(`[Webhook] Event: ${event.type} (${event.id})`);

  try {
    await handleEvent(c.env, event);
  } catch (err) {
    console.error('[Webhook] Handler error:', err);
    // Return 200 to prevent Stripe from retrying events that have business-logic errors
    // Return 500 only for truly transient errors
    return c.json({ received: true, error: String(err) }, 200);
  }

  return c.json({ received: true });
});

// ─── Event handlers ────────────────────────────────────────────────────────

async function handleEvent(env: Bindings, event: { type: string; data: { object: Record<string, unknown> } }) {
  switch (event.type) {

    // ── One-time payment (coin purchase) completed
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'payment') break;
      if (session.payment_status !== 'paid') break;

      const meta = session.metadata as Record<string, string> | undefined;
      if (!meta?.deploy_user_id || !meta?.deploy_total_coins) break;

      const userId = meta.deploy_user_id;
      const totalCoins = parseInt(meta.deploy_total_coins, 10);
      const packageId = meta.deploy_package_id || 'unknown';
      const sessionId = session.id as string;

      // Idempotency check — skip if already processed
      const existing = await env.DB.prepare(
        `SELECT id FROM coin_ledger_entries WHERE reference_type = 'stripe_session' AND reference_id = ?`
      ).bind(sessionId).first().catch(() => null);

      if (existing) {
        console.log(`[Webhook] Duplicate session ${sessionId} — skipping`);
        break;
      }

      // Credit coins
      const coinService = new CoinService(env.DB);
      await coinService.credit(
        userId, totalCoins, 'purchase',
        `Coin purchase — ${totalCoins} coins (Stripe session ${sessionId})`,
        sessionId, 'stripe_session'
      );

      // Update billing event status
      await env.DB.prepare(
        `UPDATE billing_events SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE external_id = ?`
      ).bind(sessionId).run().catch(() => {});

      // Audit log
      await env.DB.prepare(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, new_value)
         VALUES (?, ?, 'coin_purchase_completed', 'stripe_session', ?, ?)`
      ).bind(generateId('log'), userId, sessionId, JSON.stringify({ totalCoins, packageId }))
        .run().catch(() => {});

      // Send receipt email
      const userRow = await env.DB.prepare(
        `SELECT u.email, u.name, w.balance FROM users u
         JOIN coin_wallets w ON w.user_id = u.id WHERE u.id = ?`
      ).bind(userId).first<{ email: string; name: string; balance: number }>().catch(() => null);

      if (userRow) {
        const amountCents = (session.amount_total as number) || 0;
        const amountStr = `$${(amountCents / 100).toFixed(2)}`;
        const pkg = await env.DB.prepare(
          'SELECT name FROM coin_packages WHERE id = ?'
        ).bind(packageId).first<{ name: string }>().catch(() => null);

        try {
          const resend = new ResendService(env);
          await resend.sendCoinReceipt({
            to: userRow.email,
            name: userRow.name,
            packageName: pkg?.name || 'Coin Package',
            coinsAdded: totalCoins,
            newBalance: userRow.balance,
            amountPaid: amountStr,
          });
        } catch (emailErr) {
          console.error('[Webhook] Receipt email failed (non-fatal):', emailErr);
        }
      }

      console.log(`[Webhook] ✅ Credited ${totalCoins} coins to user ${userId}`);
      break;
    }

    // ── Subscription created / renewed
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const customerId = invoice.customer as string;
      if (!customerId) break;

      // Find user by Stripe customer ID
      const billing = await env.DB.prepare(
        'SELECT user_id FROM user_billing WHERE stripe_customer_id = ?'
      ).bind(customerId).first<{ user_id: string }>().catch(() => null);

      if (!billing) break;

      const subscriptionId = invoice.subscription as string;
      const amountPaid = (invoice.amount_paid as number) || 0;

      // Update billing event
      await env.DB.prepare(
        `INSERT OR REPLACE INTO billing_events (id, user_id, type, amount_cents, description, status, external_id)
         VALUES (?, ?, 'subscription_renewal', ?, ?, 'completed', ?)`
      ).bind(
        generateId('bill'), billing.user_id, amountPaid,
        `Subscription renewal — ${subscriptionId}`, subscriptionId
      ).run().catch(() => {});

      console.log(`[Webhook] ✅ Subscription renewed for user ${billing.user_id}`);
      break;
    }

    // ── Subscription cancelled (with 3-day grace period)
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = sub.customer as string;
      if (!customerId) break;

      const billing = await env.DB.prepare(
        'SELECT user_id FROM user_billing WHERE stripe_customer_id = ?'
      ).bind(customerId).first<{ user_id: string }>().catch(() => null);

      if (!billing) break;

      // Fetch user details for email
      const userRow = await env.DB.prepare(
        'SELECT email, name FROM users WHERE id = ?'
      ).bind(billing.user_id).first<{ email: string; name: string }>().catch(() => null);

      // Fetch current plan name before downgrade
      const currentPlan = await env.DB.prepare(
        `SELECT p.name, p.slug FROM plans p JOIN memberships m ON m.plan_id = p.id WHERE m.user_id = ?`
      ).bind(billing.user_id).first<{ name: string; slug: string }>().catch(() => null);

      // ── GRACE PERIOD: Schedule downgrade 3 days from now ─────────────────
      // Mark subscription as cancelled but do NOT downgrade immediately.
      // The cron handler will complete the downgrade after grace_expires_at.
      const graceExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(
        `UPDATE user_billing SET subscription_status = 'cancelled', grace_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      ).bind(graceExpiresAt, billing.user_id).run().catch(() => {});

      // Also store grace period in KV for fast cron lookups
      await env.DEPLOY_KV.put(
        `grace_period:${billing.user_id}`,
        JSON.stringify({ user_id: billing.user_id, expires_at: graceExpiresAt }),
        { expirationTtl: 4 * 24 * 60 * 60 } // 4 days TTL
      ).catch(() => {});

      // Audit log
      await env.DB.prepare(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, new_value)
         VALUES (?, ?, 'subscription_cancelled', 'subscription', ?, ?)`
      ).bind(
        generateId('log'), billing.user_id,
        sub.id as string,
        JSON.stringify({ customer_id: customerId, plan: 'free', grace_expires_at: graceExpiresAt })
      ).run().catch(() => {});

      // Notification
      await env.DB.prepare(
        `INSERT INTO notifications (id, user_id, type, title, message)
         VALUES (?, ?, 'subscription_cancelled', 'Subscription Cancelled', 'Your subscription has been cancelled. You have a 3-day grace period before your account is downgraded to the Free plan.')`
      ).bind(generateId('notif'), billing.user_id).run().catch(() => {});

      // Subscription change email
      if (userRow) {
        const resend = new ResendService(env);
        resend.sendSubscriptionChange({
          to: userRow.email,
          name: userRow.name,
          changeType: 'cancelled',
          fromPlan: currentPlan?.name || currentPlan?.slug || 'Pro',
          toPlan: 'Free',
          effectiveDate: new Date(graceExpiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        }).catch(() => {});
      }

      console.log(`[Webhook] Subscription cancelled for user ${billing.user_id} — 3-day grace period until ${graceExpiresAt}`);
      break;
    }

    // ── Payment failed
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer as string;
      if (!customerId) break;

      const billing = await env.DB.prepare(
        'SELECT user_id FROM user_billing WHERE stripe_customer_id = ?'
      ).bind(customerId).first<{ user_id: string }>().catch(() => null);

      if (!billing) break;

      await env.DB.prepare(
        `INSERT INTO billing_events (id, user_id, type, amount_cents, description, status, external_id)
         VALUES (?, ?, 'payment_failed', ?, ?, 'failed', ?)`
      ).bind(
        generateId('bill'), billing.user_id,
        (invoice.amount_due as number) || 0,
        'Subscription payment failed',
        invoice.id as string
      ).run().catch(() => {});

      // Notification to the user
      await env.DB.prepare(
        `INSERT INTO notifications (id, user_id, type, title, message)
         VALUES (?, ?, 'payment_failed', 'Payment Failed', 'Your subscription payment failed. Please update your payment method to keep your account active.')`
      ).bind(generateId('notif'), billing.user_id).run().catch(() => {});

      console.log(`[Webhook] ⚠️ Payment failed for user ${billing.user_id}`);
      break;
    }

    default:
      console.log(`[Webhook] Unhandled event type: ${event.type}`);
  }
}

export default stripeWebhook;
