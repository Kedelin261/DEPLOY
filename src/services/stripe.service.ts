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
}

// ─── Webhook event types ──────────────────────────────────────────────────────

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
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
