// DEPLOY Platform - Auth Routes

import { Hono } from 'hono';
import { authMiddleware, signJWT, hashPassword, verifyPassword, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import { ResendService } from '../services/resend.service';
import type { Bindings, Variables } from '../types';

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /api/auth/signup
auth.post('/signup', async (c) => {
  try {
    const { email, password, name } = await c.req.json();

    if (!email || !password || !name) {
      return c.json({ success: false, error: 'Email, password, and name are required' }, 400);
    }
    if (password.length < 8) {
      return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400);
    }

    // Check existing user
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (existing) {
      return c.json({ success: false, error: 'Email already registered' }, 409);
    }

    const userId = generateId('usr');
    const passwordHash = await hashPassword(password);

    // Get free plan
    const freePlan = await c.env.DB.prepare('SELECT id FROM plans WHERE slug = ?').bind('free').first<{ id: string }>();

    const membershipId = generateId('mbr');
    const coinService = new CoinService(c.env.DB);

    // Create user, membership, wallet in batch
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(userId, email.toLowerCase(), passwordHash, name, 'user', 'active'),

      c.env.DB.prepare(
        'INSERT INTO memberships (id, user_id, plan_id, status) VALUES (?, ?, ?, ?)'
      ).bind(membershipId, userId, freePlan?.id || 'plan_free', 'active'),

      c.env.DB.prepare(
        'INSERT INTO coin_wallets (id, user_id, balance, lifetime_earned, lifetime_spent) VALUES (?, ?, ?, ?, ?)'
      ).bind(generateId('wallet'), userId, 50, 50, 0),
    ]);

    // Log signup grant
    await c.env.DB.prepare(
      `INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description)
       SELECT ?, ?, w.id, 'grant', 50, 50, 'Welcome bonus coins'
       FROM coin_wallets w WHERE w.user_id = ?`
    ).bind(generateId('cle'), userId, userId).run();

    // Audit log
    await c.env.DB.prepare(
      'INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId('log'), userId, 'user_signup', 'user', userId).run();

    const jwtSecret = c.env.JWT_SECRET || 'deploy-secret-key-change-in-production';
    const token = await signJWT({ sub: userId, email: email.toLowerCase(), role: 'user' }, jwtSecret);

    // Send welcome email (non-blocking — don't fail signup if email fails)
    try {
      const resend = new ResendService(c.env);
      await resend.sendWelcome({ to: email.toLowerCase(), name, coins: 50 });
    } catch (emailErr) {
      console.error('Welcome email failed (non-fatal):', emailErr);
    }

    return c.json({
      success: true,
      data: {
        token,
        user: { id: userId, email: email.toLowerCase(), name, role: 'user', plan: 'free', coins: 50 }
      },
      message: 'Welcome to DEPLOY! You have 50 coins to get started.'
    }, 201);
  } catch (err) {
    console.error('Signup error:', err);
    return c.json({ success: false, error: 'Signup failed. Please try again.' }, 500);
  }
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) {
      return c.json({ success: false, error: 'Email and password are required' }, 400);
    }

    const user = await c.env.DB.prepare(
      `SELECT u.*, p.slug as plan_slug, w.balance as coin_balance
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN coin_wallets w ON w.user_id = u.id
       WHERE u.email = ? AND u.status = 'active'`
    ).bind(email.toLowerCase()).first<{
      id: string; email: string; password_hash: string; name: string;
      role: string; plan_slug: string; coin_balance: number;
    }>();

    if (!user) {
      return c.json({ success: false, error: 'Invalid email or password' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return c.json({ success: false, error: 'Invalid email or password' }, 401);
    }

    // Update last login
    await c.env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();

    const jwtSecret = c.env.JWT_SECRET || 'deploy-secret-key-change-in-production';
    const token = await signJWT({ sub: user.id, email: user.email, role: user.role }, jwtSecret);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id, email: user.email, name: user.name,
          role: user.role, plan: user.plan_slug || 'free',
          coins: user.coin_balance || 0
        }
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return c.json({ success: false, error: 'Login failed. Please try again.' }, 500);
  }
});

// GET /api/auth/me
auth.get('/me', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  const fullUser = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.avatar_url, u.role, u.created_at,
            p.name as plan_name, p.slug as plan_slug,
            p.monthly_coins, p.max_projects, p.max_deployments,
            w.balance as coin_balance, w.lifetime_earned, w.lifetime_spent, w.next_grant_at
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id
     LEFT JOIN plans p ON p.id = m.plan_id
     LEFT JOIN coin_wallets w ON w.user_id = u.id
     WHERE u.id = ?`
  ).bind(user.id).first();

  return c.json({ success: true, data: fullUser });
});

// PUT /api/auth/profile
auth.put('/profile', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { name, phone } = await c.req.json();

  await c.env.DB.prepare(
    'UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(name || null, phone || null, user.id).run();

  return c.json({ success: true, message: 'Profile updated' });
});

// POST /api/auth/change-password
auth.post('/change-password', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { current_password, new_password } = await c.req.json();

  if (!current_password || !new_password || new_password.length < 8) {
    return c.json({ success: false, error: 'Valid current and new password (min 8 chars) required' }, 400);
  }

  const dbUser = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!dbUser) return c.json({ success: false, error: 'User not found' }, 404);

  const valid = await verifyPassword(current_password, dbUser.password_hash);
  if (!valid) return c.json({ success: false, error: 'Current password is incorrect' }, 401);

  const newHash = await hashPassword(new_password);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id).run();

  return c.json({ success: true, message: 'Password updated successfully' });
});

// POST /api/auth/logout
auth.post('/logout', authMiddleware(), async (c) => {
  return c.json({ success: true, message: 'Logged out successfully' });
});

// POST /api/auth/forgot-password
// Generates a time-limited reset token, stores it in KV, and emails the user.
auth.post('/forgot-password', async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ success: false, error: 'Email is required' }, 400);

    const user = await c.env.DB.prepare(
      'SELECT id, name, email FROM users WHERE email = ? AND status = ?'
    ).bind(email.toLowerCase(), 'active').first<{ id: string; name: string; email: string }>();

    // Always return success to prevent email enumeration
    if (!user) {
      return c.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    }

    // Generate a secure token and store in KV (expires in 1 hour)
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const kvKey = `pwd_reset:${token}`;
    await c.env.DEPLOY_KV.put(kvKey, JSON.stringify({ userId: user.id, email: user.email }), {
      expirationTtl: 3600 // 1 hour
    });

    // Send reset email
    try {
      const resend = new ResendService(c.env);
      await resend.sendPasswordReset({ to: user.email, name: user.name, resetToken: token });
    } catch (emailErr) {
      console.error('Reset email failed:', emailErr);
      return c.json({ success: false, error: 'Failed to send reset email. Please try again.' }, 500);
    }

    return c.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot-password error:', err);
    return c.json({ success: false, error: 'An error occurred. Please try again.' }, 500);
  }
});

// POST /api/auth/reset-password
// Validates the reset token from KV and updates the password.
auth.post('/reset-password', async (c) => {
  try {
    const { token, new_password } = await c.req.json();
    if (!token || !new_password) {
      return c.json({ success: false, error: 'Token and new password are required' }, 400);
    }
    if (new_password.length < 8) {
      return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400);
    }

    // Validate token from KV
    const kvKey = `pwd_reset:${token}`;
    const stored = await c.env.DEPLOY_KV.get(kvKey);
    if (!stored) {
      return c.json({ success: false, error: 'Invalid or expired reset link. Please request a new one.' }, 400);
    }

    const { userId } = JSON.parse(stored) as { userId: string; email: string };

    // Update password
    const newHash = await hashPassword(new_password);
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(newHash, userId).run();

    // Invalidate the token immediately
    await c.env.DEPLOY_KV.delete(kvKey);

    // Audit log
    await c.env.DB.prepare(
      'INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId('log'), userId, 'password_reset', 'user', userId).run().catch(() => {});

    return c.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    return c.json({ success: false, error: 'An error occurred. Please try again.' }, 500);
  }
});

export default auth;
