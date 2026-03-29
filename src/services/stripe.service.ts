// DEPLOY Platform - Stripe Payment Service
// ALL Stripe calls are server-side only. Keys are NEVER exposed to clients.
// Frontend receives only: publishable key (via /api/config) and payment URLs.

import type { Bindings } from '../types';

// ─── Stripe API helpers ───────────────────────────────────────────────────────

async function stripeRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `https://api.stripe.com/v1${path}`;
  const headers: HeadersInit = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  let bodyStr: string | undefined;
  if (body) {
    bodyStr = encodeStripeBody(body);
  }

  const res = await fetch(url, { method, headers, body: bodyStr });
  const json = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const err = json.error as Record<string, string> | undefined;
    throw new Error(err?.message || `Stripe error: ${res.status}`);
  }
  return json;
}

/** Recursively encode nested objects into Stripe's x-www-form-urlencoded format */
function encodeStripeBody(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      parts.push(encodeStripeBody(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(encodeStripeBody(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}

// ─── StripeService class ──────────────────────────────────────────────────────

export class StripeService {
  private apiKey: string;

  constructor(private env: Bindings) {
    this.apiKey = env.STRIPE_SECRET_KEY;
    if (!this.apiKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  // ── Checkout Sessions ──────────────────────────────────────────────────────

  /**
   * Create a Stripe Checkout Session for a coin package purchase.
   * Returns the session URL which the frontend redirects to.
   */
  async createCoinCheckoutSession(opts: {
    userId: string;
    userEmail: string;
    packageId: string;
    packageName: string;
    priceCents: number;
    stripePriceId?: string;   // use pre-created Stripe price if available
    coins: number;
    bonusCoins: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ sessionId: string; url: string }> {
    const totalCoins = opts.coins + opts.bonusCoins;
    const description = `${opts.coins} coins${opts.bonusCoins > 0 ? ` + ${opts.bonusCoins} bonus` : ''} = ${totalCoins} total`;

    const lineItems = opts.stripePriceId
      ? [{ price: opts.stripePriceId, quantity: 1 }]
      : [{
          price_data: {
            currency: 'usd',
            unit_amount: opts.priceCents,
            product_data: {
              name: `DEPLOY Coins — ${opts.packageName}`,
              description,
            },
          },
          quantity: 1,
        }];

    const session = await stripeRequest(this.apiKey, 'POST', '/checkout/sessions', {
      mode: 'payment',
      customer_email: opts.userEmail,
      line_items: lineItems,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      metadata: {
        deploy_user_id: opts.userId,
        deploy_package_id: opts.packageId,
        deploy_coins: String(opts.coins),
        deploy_bonus_coins: String(opts.bonusCoins),
        deploy_total_coins: String(totalCoins),
      },
      payment_intent_data: {
        metadata: {
          deploy_user_id: opts.userId,
          deploy_package_id: opts.packageId,
        },
      },
    }) as { id: string; url: string };

    return { sessionId: session.id, url: session.url };
  }

  /**
   * Create a Stripe Checkout Session for a subscription plan upgrade.
   */
  async createSubscriptionCheckoutSession(opts: {
    userId: string;
    userEmail: string;
    planSlug: string;
    planName: string;
    stripePriceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ sessionId: string; url: string }> {
    const session = await stripeRequest(this.apiKey, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      customer_email: opts.userEmail,
      line_items: [{ price: opts.stripePriceId, quantity: 1 }],
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      metadata: {
        deploy_user_id: opts.userId,
        deploy_plan_slug: opts.planSlug,
      },
      subscription_data: {
        metadata: {
          deploy_user_id: opts.userId,
          deploy_plan_slug: opts.planSlug,
        },
      },
    }) as { id: string; url: string };

    return { sessionId: session.id, url: session.url };
  }

  // ── Webhook Verification ──────────────────────────────────────────────────

  /**
   * Verify a Stripe webhook signature using HMAC-SHA256.
   * Returns the parsed event or throws on failure.
   */
  async verifyWebhook(
    rawBody: string,
    signature: string
  ): Promise<StripeWebhookEvent> {
    const webhookSecret = this.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || webhookSecret.startsWith('whsec_REPLACE')) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    // Parse Stripe-Signature header: t=1234567890,v1=abcdef...
    // Use indexOf('=') so hex values containing '=' aren't split incorrectly
    const parts: Record<string, string> = {};
    for (const chunk of signature.split(',')) {
      const eqIdx = chunk.indexOf('=');
      if (eqIdx !== -1) {
        parts[chunk.slice(0, eqIdx)] = chunk.slice(eqIdx + 1);
      }
    }
    const timestamp = parts.t;
    const v1 = parts.v1;

    if (!timestamp || !v1) throw new Error('Invalid Stripe-Signature header');

    // Verify timestamp is within 5 minutes
    const tsDiff = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (tsDiff > 300) throw new Error('Webhook timestamp too old');

    // Compute expected signature.
    // Stripe signs with the raw secret AFTER stripping the "whsec_" prefix.
    const signedPayload = `${timestamp}.${rawBody}`;
    const enc = new TextEncoder();
    const rawSecret = webhookSecret.startsWith('whsec_')
      ? webhookSecret.slice('whsec_'.length)
      : webhookSecret;
    const keyData = enc.encode(rawSecret);
    const msgData = enc.encode(signedPayload);

    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', key, msgData);
    const expected = Array.from(new Uint8Array(sigBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (expected !== v1) throw new Error('Webhook signature mismatch');

    return JSON.parse(rawBody) as StripeWebhookEvent;
  }

  // ── Customer Portal ────────────────────────────────────────────────────────

  /**
   * Create a Stripe Customer Portal session so users can manage subscriptions.
   */
  async createPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await stripeRequest(this.apiKey, 'POST', '/billing_portal/sessions', {
      customer: opts.customerId,
      return_url: opts.returnUrl,
    }) as { url: string };

    return { url: session.url };
  }

  // ── Retrieve Checkout Session ──────────────────────────────────────────────

  async retrieveSession(sessionId: string): Promise<StripeCheckoutSession> {
    return await stripeRequest(this.apiKey, 'GET', `/checkout/sessions/${sessionId}`) as StripeCheckoutSession;
  }

  // ── Customer Management ────────────────────────────────────────────────────

  /** Create or retrieve a Stripe Customer for a user */
  async getOrCreateCustomer(opts: {
    userId: string;
    email: string;
    name: string;
    existingCustomerId?: string;
  }): Promise<string> {
    if (opts.existingCustomerId) return opts.existingCustomerId;

    const customer = await stripeRequest(this.apiKey, 'POST', '/customers', {
      email: opts.email,
      name: opts.name,
      metadata: { deploy_user_id: opts.userId },
    }) as { id: string };

    return customer.id;
  }

  // ── SetupIntent (save card without charging) ───────────────────────────────

  /**
   * Create a SetupIntent so the frontend can collect and save a card
   * using Stripe.js Elements — no payment taken yet.
   */
  async createSetupIntent(customerId: string): Promise<{ clientSecret: string; setupIntentId: string }> {
    const si = await stripeRequest(this.apiKey, 'POST', '/setup_intents', {
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    }) as { id: string; client_secret: string };

    return { clientSecret: si.client_secret, setupIntentId: si.id };
  }

  // ── Retrieve SetupIntent (after confirmation) ──────────────────────────────

  async retrieveSetupIntent(setupIntentId: string): Promise<{ paymentMethodId: string; status: string }> {
    const si = await stripeRequest(this.apiKey, 'GET', `/setup_intents/${setupIntentId}`) as {
      status: string;
      payment_method: string;
    };
    return { paymentMethodId: si.payment_method, status: si.status };
  }

  // ── Retrieve saved PaymentMethod details ──────────────────────────────────

  async retrievePaymentMethod(pmId: string): Promise<SavedCard> {
    const pm = await stripeRequest(this.apiKey, 'GET', `/payment_methods/${pmId}`) as {
      id: string;
      card: { brand: string; last4: string; exp_month: number; exp_year: number };
    };
    return {
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    };
  }

  // ── List customer's saved PaymentMethods ──────────────────────────────────

  async listPaymentMethods(customerId: string): Promise<SavedCard[]> {
    const result = await stripeRequest(
      this.apiKey, 'GET',
      `/payment_methods?customer=${encodeURIComponent(customerId)}&type=card&limit=10`
    ) as { data: Array<{ id: string; card: { brand: string; last4: string; exp_month: number; exp_year: number } }> };

    return result.data.map(pm => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    }));
  }

  // ── Detach / delete a saved PaymentMethod ─────────────────────────────────

  async detachPaymentMethod(pmId: string): Promise<void> {
    await stripeRequest(this.apiKey, 'POST', `/payment_methods/${pmId}/detach`, {});
  }

  // ── Charge a saved card directly (PaymentIntent) ──────────────────────────

  /**
   * Charge a saved payment method immediately — no redirect required.
   * Used when a user has a card on file and confirms the purchase in-app.
   */
  async chargePaymentMethod(opts: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    description: string;
    metadata: Record<string, string>;
  }): Promise<{ paymentIntentId: string; status: string }> {
    const pi = await stripeRequest(this.apiKey, 'POST', '/payment_intents', {
      amount: opts.amountCents,
      currency: 'usd',
      customer: opts.customerId,
      payment_method: opts.paymentMethodId,
      description: opts.description,
      metadata: opts.metadata,
      confirm: 'true',           // charge immediately
      off_session: 'true',       // user is not actively in Stripe's flow
      return_url: '',            // required field but unused for off_session
    }) as { id: string; status: string };

    return { paymentIntentId: pi.id, status: pi.status };
  }
}

// ─── Webhook event types ──────────────────────────────────────────────────────

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
};

export type SavedCard = {
  id: string;          // Stripe PaymentMethod ID (pm_...)
  brand: string;       // visa, mastercard, amex, etc.
  last4: string;
  expMonth: number;
  expYear: number;
};

export type StripeCheckoutSession = {
  id: string;
  mode: string;
  payment_status: string;
  metadata: Record<string, string>;
  customer_email?: string;
  customer?: string;
  subscription?: string;
  amount_total?: number;
  currency?: string;
};
