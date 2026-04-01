// DEPLOY Platform - Rate Limiting Middleware
// Sliding-window rate limiter backed by Cloudflare D1.
// Falls back to allow-through if D1 is unavailable (non-blocking).

import type { Context, Next } from 'hono';
import type { Bindings, Variables } from '../types';

export interface RateLimitConfig {
  windowSeconds: number;   // e.g. 60
  maxRequests: number;     // e.g. 20
  keyPrefix: string;       // e.g. "auth:login"
  message?: string;
}

// Predefined rate-limit profiles for different endpoint categories
export const RATE_LIMITS = {
  // Auth endpoints — strict
  auth_login:    { windowSeconds: 60,  maxRequests: 10,  keyPrefix: 'rl:auth:login',    message: 'Too many login attempts. Please wait a minute and try again.' },
  auth_signup:   { windowSeconds: 60,  maxRequests: 5,   keyPrefix: 'rl:auth:signup',   message: 'Too many signup attempts. Please wait a minute and try again.' },
  auth_forgot:   { windowSeconds: 300, maxRequests: 3,   keyPrefix: 'rl:auth:forgot',   message: 'Too many password reset requests. Please wait 5 minutes.' },

  // Build endpoints — per user, protect AI spend
  build_request: { windowSeconds: 300, maxRequests: 5,   keyPrefix: 'rl:build',        message: 'Too many build requests. Please wait 5 minutes.' },
  ai_assist:     { windowSeconds: 60,  maxRequests: 20,  keyPrefix: 'rl:ai_assist',     message: 'Too many AI assist requests. Please slow down.' },
  chat:          { windowSeconds: 60,  maxRequests: 30,  keyPrefix: 'rl:chat',          message: 'Too many chat messages. Please slow down.' },
  summarize:     { windowSeconds: 60,  maxRequests: 10,  keyPrefix: 'rl:summarize',     message: 'Too many summary requests. Please slow down.' },

  // Vault / payment — strict
  checkout:      { windowSeconds: 60,  maxRequests: 5,   keyPrefix: 'rl:checkout',      message: 'Too many payment attempts. Please wait a minute.' },

  // General API — permissive
  api_general:   { windowSeconds: 60,  maxRequests: 120, keyPrefix: 'rl:api',           message: 'Rate limit exceeded. Please slow down.' },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;

function getWindowStart(now: Date, windowSeconds: number): string {
  const bucket = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
  return new Date(bucket).toISOString();
}

function getClientKey(c: Context<{ Bindings: Bindings; Variables: Variables }>, config: RateLimitConfig, userId?: string): string {
  // Prefer user ID for authenticated routes; fall back to IP
  const identifier = userId ||
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';
  return `${config.keyPrefix}:${identifier}`;
}

export async function checkRateLimit(
  db: D1Database,
  key: string,
  config: RateLimitConfig,
  now: Date = new Date()
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  const windowStart = getWindowStart(now, config.windowSeconds);

  try {
    // Upsert: increment counter for this key+window
    const result = await db.prepare(
      `INSERT INTO rate_limits (id, key, window_start, count, updated_at)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(key, window_start) DO UPDATE SET
         count = count + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING count`
    ).bind(crypto.randomUUID(), key, windowStart).first<{ count: number }>();

    const count = result?.count ?? 1;

    if (count > config.maxRequests) {
      const windowEndMs = new Date(windowStart).getTime() + config.windowSeconds * 1000;
      const retryAfter = Math.ceil((windowEndMs - now.getTime()) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: Math.max(0, config.maxRequests - count) };
  } catch {
    // D1 unavailable — fail open to avoid blocking legitimate requests
    return { allowed: true, remaining: config.maxRequests };
  }
}

// Hono middleware factory
export function rateLimitMiddleware(
  configKey: RateLimitKey,
  getUserId?: (c: Context<{ Bindings: Bindings; Variables: Variables }>) => string | undefined
) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const config = RATE_LIMITS[configKey];
    const userId = getUserId ? getUserId(c) : c.get('user')?.id;
    const key = getClientKey(c, config, userId);

    const { allowed, remaining, retryAfter } = await checkRateLimit(c.env.DB, key, config);

    // Always set rate limit headers
    c.header('X-RateLimit-Limit', String(config.maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Window', String(config.windowSeconds));

    if (!allowed) {
      if (retryAfter) c.header('Retry-After', String(retryAfter));
      return c.json({
        success: false,
        error: config.message || 'Rate limit exceeded.',
        retry_after_seconds: retryAfter || config.windowSeconds,
      }, 429);
    }

    return next();
  };
}

// Utility: Clean up expired rate limit entries (call from health check)
export async function cleanupRateLimits(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      `DELETE FROM rate_limits WHERE window_start < datetime('now', '-1 hour')`
    ).run();
  } catch { /* non-fatal */ }
}
