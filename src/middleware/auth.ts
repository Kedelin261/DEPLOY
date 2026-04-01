// DEPLOY Platform - Auth Middleware

import type { Context, Next } from 'hono';
import type { Bindings, Variables, AuthUser } from '../types';

function base64urlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const data = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(data));

    if (!valid) return null;

    const payload = JSON.parse(base64urlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function signJWT(payload: Record<string, unknown>, secret: string, expiresInHours = 24 * 7): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInHours * 3600 };

  const encode = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const headerB64 = encode(header);
  const payloadB64 = encode(fullPayload);
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${data}.${sigB64}`;
}

export function authMiddleware(required = true) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const authHeader = c.req.header('Authorization');
    const cookieHeader = c.req.header('Cookie');

    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (cookieHeader) {
      const match = cookieHeader.match(/deploy_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      if (required) {
        return c.json({ success: false, error: 'Authentication required' }, 401);
      }
      await next();
      return;
    }

    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error('[Auth] JWT_SECRET is not configured');
      return c.json({ success: false, error: 'Server configuration error' }, 500);
    }
    const payload = await verifyJWT(token, jwtSecret);

    if (!payload) {
      if (required) {
        return c.json({ success: false, error: 'Invalid or expired token' }, 401);
      }
      await next();
      return;
    }

    // Load user from DB
    const user = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.status,
              m.plan_id, p.slug as plan_slug,
              w.balance as coin_balance
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN coin_wallets w ON w.user_id = u.id
       WHERE u.id = ? AND u.status = 'active'`
    ).bind(payload.sub).first<AuthUser & { status: string }>();

    if (!user) {
      if (required) {
        return c.json({ success: false, error: 'User not found' }, 401);
      }
      await next();
      return;
    }

    c.set('user', {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as 'user' | 'admin',
      plan_slug: user.plan_slug || 'free',
      coin_balance: user.coin_balance || 0,
    });

    await next();
  };
}

export function adminMiddleware() {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const user = c.get('user');
    if (!user || user.role !== 'admin') {
      return c.json({ success: false, error: 'Admin access required' }, 403);
    }
    await next();
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    const [saltHex, storedHash] = hash.split(':');
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === storedHash;
  } catch {
    return false;
  }
}

export function generateId(prefix = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 9);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
