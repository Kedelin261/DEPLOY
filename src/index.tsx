// DEPLOY Platform - Main Application Entry Point
// Built on Hono + Cloudflare Workers/Pages

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
// serveStatic is NOT used — static files (app.js, styles.css) are inlined or served via Cloudflare Pages automatically
import { cleanupRateLimits } from './middleware/rateLimit';
import type { Bindings, Variables } from './types';

// Route imports
import authRoutes from './routes/auth';
import projectRoutes from './routes/projects';
import promptRoutes from './routes/prompt';
import vaultRoutes from './routes/vault';
import modelRoutes from './routes/models';
import deploymentRoutes from './routes/deployments';
import adminRoutes from './routes/admin';
import notificationRoutes from './routes/notifications';
import stripeWebhookRoutes from './routes/stripe-webhook';
import learnRoutes from './routes/learn';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ============================================================
// MIDDLEWARE
// ============================================================
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

// ============================================================
// STATIC FILES
// Cloudflare Pages serves public/ automatically — no serveStatic needed.
// wrangler pages dev also handles public/ assets natively.
// ============================================================

// ============================================================
// API ROUTES
// ============================================================
// Stripe webhook — must be registered BEFORE general routes
// so it can read the raw body without JSON parsing interference
app.route('/api/webhooks/stripe', stripeWebhookRoutes);

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/prompt', promptRoutes);
app.route('/api/vault', vaultRoutes);
app.route('/api/models', modelRoutes);
app.route('/api/deployments', deploymentRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/learn', learnRoutes);

// Health check — also cleans up any jobs stuck in 'processing' from a previous server crash
app.get('/api/health', async (c) => {
  // Auto-fix: reset any jobs stuck in processing/queued for > 10 minutes
  // These are jobs where the background task was killed by the runtime
  try {
    const stuckJobs = await c.env.DB.prepare(
      `SELECT id, user_id, coin_hold_id, coins_held FROM build_jobs 
       WHERE status IN ('processing','queued') 
       AND created_at < datetime('now', '-10 minutes')`
    ).all<{ id: string; user_id: string; coin_hold_id: string; coins_held: number }>();

    for (const job of stuckJobs.results) {
      await c.env.DB.prepare(
        `UPDATE build_jobs SET status='failed', error_message='Build timed out — please try again', completed_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(job.id).run();
      // Return held coins
      if (job.coin_hold_id) {
        await c.env.DB.prepare(
          `UPDATE coin_holds SET status='released', released_at=CURRENT_TIMESTAMP WHERE id=?`
        ).bind(job.coin_hold_id).run();
        await c.env.DB.prepare(
          `UPDATE coin_wallets SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
        ).bind(job.coins_held || 0, job.user_id).run();
      }
    }
    // Reset any project stuck in 'building'
    await c.env.DB.prepare(
      `UPDATE projects SET status='draft', updated_at=CURRENT_TIMESTAMP 
       WHERE status='building' AND updated_at < datetime('now', '-10 minutes')`
    ).run();
    // Cleanup expired rate limit windows
    await cleanupRateLimits(c.env.DB);
  } catch { /* non-fatal */ }

  return c.json({
    status: 'healthy',
    service: 'DEPLOY Platform',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT || 'development'
  });
});

// ── Public config endpoint ──────────────────────────────────────────────────
// Exposes ONLY safe, non-secret configuration to the frontend.
// This is the ONLY way the frontend learns the Stripe publishable key.
app.get('/api/config', (c) => {
  return c.json({
    success: true,
    data: {
      stripe_publishable_key: c.env.STRIPE_PUBLISHABLE_KEY || null,
      environment: c.env.ENVIRONMENT || 'development',
      app_url: c.env.APP_URL || 'http://localhost:3000',
    }
  });
});

// Plans endpoint (public)
app.get('/api/plans', async (c) => {
  const plans = await c.env.DB.prepare(
    'SELECT id, name, slug, description, monthly_coins, max_projects, max_uploads, max_deployments, model_access, price_cents FROM plans WHERE is_active = 1 ORDER BY price_cents ASC'
  ).all();
  return c.json({ success: true, data: plans.results });
});

// Admin Dashboard (separate HTML page)
app.get('/admin', (c) => c.html(getAdminHTML()));
app.get('/admin/*', (c) => c.html(getAdminHTML()));

// 404 for unknown API routes
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ success: false, error: 'API endpoint not found' }, 404);
  }
  // Serve the SPA for all non-API routes
  return c.html(getAppHTML());
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
  return c.html(getAppHTML());
});

// ============================================================
// FRONTEND SPA - The DEPLOY App
// ============================================================
app.get('*', (c) => {
  return c.html(getAppHTML());
});

function getAppHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#0a0e1a">
  <meta name="description" content="DEPLOY — From Idea to App. One Prompt.">
  <title>DEPLOY</title>
  
  <!-- Preconnect -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  
  <!-- Fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  
  <!-- Icons -->
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  
  <!-- Tailwind -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            navy: {
              950: '#050810',
              900: '#0a0e1a',
              800: '#0d1224',
              700: '#111829',
              600: '#162035',
              500: '#1e2d4a',
            },
            cyan: {
              400: '#22d3ee',
              500: '#06b6d4',
            },
            amber: {
              400: '#fbbf24',
              500: '#f59e0b',
            }
          },
          fontFamily: {
            sans: ['Inter', 'system-ui', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          }
        }
      }
    }
  </script>
  
  <style>
    * { -webkit-tap-highlight-color: transparent; }
    body {
      background: #0a0e1a;
      color: #e2e8f0;
      font-family: 'Inter', system-ui, sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }
    /* Scrollbar */
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: #0d1224; }
    ::-webkit-scrollbar-thumb { background: #22d3ee33; border-radius: 2px; }
    
    /* Glass card */
    .glass {
      background: rgba(13, 18, 36, 0.8);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(34, 211, 238, 0.1);
    }
    .glass-hover:hover {
      background: rgba(13, 18, 36, 0.95);
      border-color: rgba(34, 211, 238, 0.25);
    }
    
    /* Glow effects */
    .glow-cyan { box-shadow: 0 0 30px rgba(34, 211, 238, 0.15); }
    .glow-amber { box-shadow: 0 0 30px rgba(251, 191, 36, 0.15); }
    .text-glow { text-shadow: 0 0 20px rgba(34, 211, 238, 0.5); }
    
    /* Gradient text */
    .gradient-text {
      background: linear-gradient(135deg, #22d3ee, #06b6d4, #fbbf24);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    /* Button styles */
    .btn-primary {
      background: linear-gradient(135deg, #06b6d4, #0891b2);
      color: white;
      transition: all 0.2s;
    }
    .btn-primary:hover { 
      background: linear-gradient(135deg, #22d3ee, #06b6d4);
      box-shadow: 0 0 20px rgba(34, 211, 238, 0.3);
      transform: translateY(-1px);
    }
    .btn-primary:active { transform: translateY(0); }
    
    .btn-ghost {
      background: transparent;
      border: 1px solid rgba(34, 211, 238, 0.2);
      color: #94a3b8;
      transition: all 0.2s;
    }
    .btn-ghost:hover {
      border-color: rgba(34, 211, 238, 0.5);
      color: #22d3ee;
      background: rgba(34, 211, 238, 0.05);
    }
    
    /* Bottom nav */
    .bottom-nav {
      background: rgba(10, 14, 26, 0.95);
      backdrop-filter: blur(20px);
      border-top: 1px solid rgba(34, 211, 238, 0.1);
    }
    .nav-item.active .nav-icon { color: #22d3ee; }
    .nav-item.active .nav-dot { opacity: 1; }
    .nav-item .nav-dot { opacity: 0; transition: opacity 0.2s; }
    
    /* Animations */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse-glow {
      0%, 100% { opacity: 0.8; }
      50% { opacity: 1; box-shadow: 0 0 20px rgba(34, 211, 238, 0.4); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes spin-slow { to { transform: rotate(360deg); } }
    
    .animate-fade-up { animation: fadeInUp 0.4s ease forwards; }
    .animate-pulse-glow { animation: pulse-glow 2s infinite; }
    .shimmer {
      background: linear-gradient(90deg, #0d1224 25%, #162035 50%, #0d1224 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
    
    /* Progress bar */
    .progress-fill {
      background: linear-gradient(90deg, #06b6d4, #22d3ee, #fbbf24);
      transition: width 0.5s ease;
    }

    /* Thinking indicator */
    #thinking-line {
      transition: opacity 0.3s ease;
    }
    #thinking-line .thinking-text {
      animation: thinking-pulse 1.8s ease-in-out infinite;
    }
    @keyframes thinking-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.45; }
    }
    /* Spinning ⟳ character */
    #thinking-line .thinking-text::first-letter {
      display: inline-block;
      animation: spin-thinking 1.2s linear infinite;
    }
    @keyframes spin-thinking {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Build preview terminal */
    #preview-terminal {
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      line-height: 1.6;
      scrollbar-width: thin;
      scrollbar-color: #374151 transparent;
    }
    #preview-terminal::-webkit-scrollbar { width: 4px; }
    #preview-terminal::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
    .typing-line {
      overflow: hidden;
      white-space: nowrap;
      animation: typeIn 0.4s steps(40) forwards;
    }
    @keyframes typeIn {
      from { max-width: 0; opacity: 0; }
      to { max-width: 100%; opacity: 1; }
    }
    
    /* Input styles */
    .deploy-input {
      background: rgba(13, 18, 36, 0.8);
      border: 1px solid rgba(34, 211, 238, 0.15);
      color: #e2e8f0;
      transition: all 0.2s;
    }
    .deploy-input:focus {
      outline: none;
      border-color: rgba(34, 211, 238, 0.5);
      box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.1);
    }
    .deploy-input::placeholder { color: #475569; }
    
    /* Coin badge */
    .coin-badge {
      background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(245, 158, 11, 0.1));
      border: 1px solid rgba(251, 191, 36, 0.3);
    }
    
    /* Status chips */
    .chip-active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .chip-pending { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
    .chip-error { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .chip-draft { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
    
    /* Model tag */
    .tag-fast { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
    .tag-premium { background: rgba(251, 191, 36, 0.1); color: #fbbf24; }
    .tag-reasoning { background: rgba(168, 85, 247, 0.1); color: #c084fc; }
    .tag-coding { background: rgba(34, 211, 238, 0.1); color: #22d3ee; }
    .tag-balanced { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
    .tag-long-context { background: rgba(244, 63, 94, 0.1); color: #fb7185; }
    
    /* Safe area */
    .safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0); }
    
    /* Page transitions */
    .page { display: none; }
    .page.active { display: block; animation: fadeInUp 0.3s ease; }
    
    /* Planning page — Kanban breaks out of max-w-2xl and fills full screen */
    #page-planning.active {
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 30;
      background: #060912;
      overflow: hidden;
      padding-top: 60px;  /* below sticky header */
      padding-bottom: 68px; /* above bottom nav */
    }
    /* When planning is active, hide the page wrapper scroll */
    body.planning-active #main-content { overflow: hidden; }

    
    /* Toast */
    #toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999; pointer-events: none; }
    .toast {
      background: rgba(13, 18, 36, 0.95);
      border: 1px solid rgba(34, 211, 238, 0.2);
      backdrop-filter: blur(12px);
      animation: fadeInUp 0.3s ease;
      pointer-events: auto;
    }
    .toast.success { border-color: rgba(34, 197, 94, 0.4); }
    .toast.error { border-color: rgba(239, 68, 68, 0.4); }
    .toast.warning { border-color: rgba(251, 191, 36, 0.4); }
    
    /* Loader overlay */
    #loader { display: none; }
    #loader.active { display: flex; }
    
    /* Modal */
    .modal-overlay { background: rgba(5, 8, 16, 0.85); backdrop-filter: blur(8px); }
  </style>
</head>
<body>

<!-- Toast Container -->
<div id="toast-container"></div>

<!-- Global Loader -->
<div id="loader" class="fixed inset-0 z-50 items-center justify-center bg-navy-950">
  <div class="flex flex-col items-center gap-4">
    <div class="w-12 h-12 border-2 border-cyan-500 border-t-transparent rounded-full" style="animation: spin-slow 1s linear infinite"></div>
    <p class="text-slate-400 text-sm font-medium">Loading DEPLOY...</p>
  </div>
</div>

<!-- Auth Screen -->
<div id="auth-screen" class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm">
    <!-- Logo -->
    <div class="text-center mb-10">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4" 
           style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 50%, #fbbf24 100%)">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M8 6L24 16L8 26V6Z" fill="white" opacity="0.9"/>
          <path d="M20 10L28 16L20 22V10Z" fill="white" opacity="0.5"/>
        </svg>
      </div>
      <h1 class="text-3xl font-black gradient-text tracking-tight">DEPLOY</h1>
      <p class="text-slate-500 text-sm mt-1">From Idea to App. One Prompt.</p>
    </div>
    
    <!-- Auth tabs -->
    <div class="flex mb-6 p-1 glass rounded-xl">
      <button onclick="showAuthTab('login')" id="tab-login"
        class="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all text-white"
        style="background: linear-gradient(135deg, #06b6d4, #0891b2)">Sign In</button>
      <button onclick="showAuthTab('signup')" id="tab-signup"
        class="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all text-slate-400">Create Account</button>
    </div>
    
    <!-- Login Form -->
    <form id="form-login" class="space-y-4" onsubmit="event.preventDefault(); handleLogin()">
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Email</label>
        <input id="login-email" type="email" placeholder="your@email.com" autocomplete="email"
          class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
      </div>
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Password</label>
        <div class="relative">
          <input id="login-password" type="password" placeholder="••••••••" autocomplete="current-password"
            class="deploy-input w-full px-4 py-3 rounded-xl text-sm pr-11">
          <button onclick="togglePassword('login-password')" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
            <i class="fas fa-eye text-sm"></i>
          </button>
        </div>
      </div>
      <button type="submit" class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold mt-2">
        Sign In
      </button>
      <div class="text-center">
        <button type="button" class="text-xs text-slate-500 hover:text-cyan-400 transition-colors">Forgot password?</button>
      </div>
    </form>
    
    <!-- Signup Form -->
    <form id="form-signup" class="space-y-4 hidden" onsubmit="event.preventDefault(); handleSignup()">
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Full Name</label>
        <input id="signup-name" type="text" placeholder="Your name" autocomplete="name"
          class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
      </div>
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Email</label>
        <input id="signup-email" type="email" placeholder="your@email.com" autocomplete="email"
          class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
      </div>
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Password</label>
        <div class="relative">
          <input id="signup-password" type="password" placeholder="Min 8 characters" autocomplete="new-password"
            class="deploy-input w-full px-4 py-3 rounded-xl text-sm pr-11">
          <button onclick="togglePassword('signup-password')" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
            <i class="fas fa-eye text-sm"></i>
          </button>
        </div>
      </div>
      <button type="submit" class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold mt-2">
        Create Account — Free
      </button>
      <p class="text-center text-xs text-slate-500">50 free coins to get started • No credit card required</p>
    </form>
    
    <!-- Demo access -->
    <div class="mt-6 pt-6 border-t border-slate-800 text-center">
      <button onclick="handleDemoLogin()" class="text-xs text-slate-500 hover:text-cyan-400 transition-colors">
        <i class="fas fa-play-circle mr-1"></i> Try demo account
      </button>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="app-screen" class="hidden min-h-screen flex flex-col">
  
  <!-- Top Bar -->
  <header class="sticky top-0 z-40 bottom-nav px-4 py-3">
    <div class="flex items-center justify-between max-w-2xl mx-auto">
      <!-- Logo -->
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center"
             style="background: linear-gradient(135deg, #06b6d4, #fbbf24)">
          <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
            <path d="M8 6L24 16L8 26V6Z" fill="white"/>
          </svg>
        </div>
        <span class="font-black text-white tracking-tight text-lg">DEPLOY</span>
      </div>
      
      <!-- Right actions -->
      <div class="flex items-center gap-2">
        <!-- Coin balance -->
        <div class="coin-badge flex items-center gap-1.5 px-3 py-1.5 rounded-full">
          <i class="fas fa-coins text-amber-400 text-xs"></i>
          <span id="header-coins" class="text-amber-400 text-xs font-bold">0</span>
        </div>
        <!-- Notifications -->
        <button onclick="loadNotifications()" class="relative w-8 h-8 flex items-center justify-center rounded-lg btn-ghost">
          <i class="fas fa-bell text-slate-400 text-sm"></i>
          <span id="notif-badge" class="hidden absolute -top-0.5 -right-0.5 w-4 h-4 bg-cyan-500 text-white text-xs flex items-center justify-center rounded-full">0</span>
        </button>
        <!-- Model selector -->
        <button onclick="openModelSelector()" id="model-btn"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg btn-ghost text-xs font-medium">
          <i class="fas fa-robot text-cyan-400 text-xs"></i>
          <span id="current-model-name" class="text-slate-300 hidden sm:block">GPT-4o Mini</span>
          <i class="fas fa-chevron-down text-slate-500 text-xs"></i>
        </button>
      </div>
    </div>
  </header>
  
  <!-- Page Content -->
  <main id="main-content" class="flex-1 pb-24 overflow-y-auto">
    <div id="page-wrapper" class="max-w-2xl mx-auto px-4">
      <!-- HOME PAGE -->
      <div id="page-home" class="page active pt-4 space-y-5">
        <!-- Welcome + Stats -->
        <div class="animate-fade-up">
          <div class="flex items-center justify-between mb-4">
            <div>
              <p class="text-slate-500 text-xs font-medium uppercase tracking-wider">Welcome back</p>
              <h2 id="home-username" class="text-xl font-bold text-white mt-0.5">Builder</h2>
            </div>
            <div class="text-right">
              <p class="text-xs text-slate-500">Plan</p>
              <span id="home-plan" class="text-xs font-semibold text-cyan-400 capitalize">Free</span>
            </div>
          </div>
          
          <!-- Quick stats row — Command Center KPIs -->
          <div class="grid grid-cols-3 gap-2">
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-coins" class="text-lg font-black text-amber-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Coins</p>
              <p id="home-coin-trend" class="text-xs text-slate-600 mt-0.5 truncate"></p>
            </div>
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-projects" class="text-lg font-black text-cyan-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Projects</p>
              <p id="home-total-builds" class="text-xs text-slate-600 mt-0.5">0 builds</p>
            </div>
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-deploys" class="text-lg font-black text-emerald-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Deployed</p>
              <p id="home-readiness-avg" class="text-xs text-slate-600 mt-0.5">0% avg ready</p>
            </div>
          </div>
        </div>
        
        <!-- Quick Actions -->
        <div class="animate-fade-up">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Quick Actions</p>
          <div class="grid grid-cols-2 gap-3">
            <button onclick="showNewProjectModal()" 
              class="glass glass-hover rounded-xl p-4 text-left group transition-all">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
                   style="background: linear-gradient(135deg, rgba(6,182,212,0.2), rgba(6,182,212,0.1))">
                <i class="fas fa-plus text-cyan-400"></i>
              </div>
              <p class="text-sm font-semibold text-white">New Project</p>
              <p class="text-xs text-slate-500 mt-0.5">Start building</p>
            </button>
            <button onclick="navigateTo('prompt')"
              class="glass glass-hover rounded-xl p-4 text-left group transition-all">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
                   style="background: linear-gradient(135deg, rgba(251,191,36,0.2), rgba(251,191,36,0.1))">
                <i class="fas fa-wand-magic-sparkles text-amber-400"></i>
              </div>
              <p class="text-sm font-semibold text-white">Prompt Builder</p>
              <p class="text-xs text-slate-500 mt-0.5">Define your app</p>
            </button>
            <button onclick="navigateTo('account')"
              class="glass glass-hover rounded-xl p-4 text-left group transition-all">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
                   style="background: linear-gradient(135deg, rgba(168,85,247,0.2), rgba(168,85,247,0.1))">
                <i class="fas fa-coins text-purple-400"></i>
              </div>
              <p class="text-sm font-semibold text-white">Coin Vault</p>
              <p class="text-xs text-slate-500 mt-0.5">Manage credits</p>
            </button>
            <button onclick="navigateTo('info')"
              class="glass glass-hover rounded-xl p-4 text-left group transition-all">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
                   style="background: linear-gradient(135deg, rgba(34,197,94,0.2), rgba(34,197,94,0.1))">
                <i class="fas fa-rocket text-emerald-400"></i>
              </div>
              <p class="text-sm font-semibold text-white">How It Works</p>
              <p class="text-xs text-slate-500 mt-0.5">Get started</p>
            </button>
          </div>
        </div>
        
        <!-- Recent Projects -->
        <div class="animate-fade-up">
          <div class="flex items-center justify-between mb-3">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent Projects</p>
            <button onclick="loadProjects()" class="text-xs text-cyan-400">Refresh</button>
          </div>
          <div id="projects-list" class="space-y-2">
            <div class="glass rounded-xl p-4 text-center py-8">
              <i class="fas fa-folder-open text-slate-600 text-2xl mb-3 block"></i>
              <p class="text-slate-500 text-sm">No projects yet</p>
              <button onclick="showNewProjectModal()" class="mt-3 text-xs text-cyan-400 hover:text-cyan-300">
                Create your first project →
              </button>
            </div>
          </div>
        </div>
        
        <!-- Recent Activity -->
        <div class="animate-fade-up" id="activity-section">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Activity</p>
          <div id="activity-list" class="space-y-2">
            <div class="text-center py-6 text-slate-600 text-sm">No recent activity</div>
          </div>
        </div>
      </div>
      
      <!-- PROMPT PAGE -->
      <div id="page-prompt" class="page pt-4">
        <div class="animate-fade-up">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-xl font-bold text-white">Prompt Builder</h2>
              <p class="text-xs text-slate-500 mt-0.5">Define your app, section by section</p>
            </div>
            <button onclick="showNewProjectModal('prompt')" class="btn-primary px-3 py-2 rounded-lg text-xs font-semibold">
              <i class="fas fa-plus mr-1"></i> New
            </button>
          </div>
          
          <!-- Project selector for prompt -->
          <div id="prompt-project-select" class="glass rounded-xl p-4 mb-4">
            <p class="text-sm text-slate-400 mb-2">Select a project to work on:</p>
            <div id="prompt-project-list" class="space-y-2">
              <p class="text-slate-600 text-sm text-center py-3">Create a project to start building</p>
            </div>
          </div>
          
          <!-- Active Prompt Builder -->
          <div id="prompt-builder" class="hidden space-y-4">
            <!-- Progress bar -->
            <div class="glass rounded-xl p-4">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <p id="active-project-name" class="text-sm font-semibold text-white">Project Name</p>
                  <p class="text-xs text-slate-500 mt-0.5">App Blueprint</p>
                </div>
                <div class="text-right">
                  <p id="completeness-pct" class="text-lg font-black text-cyan-400">0%</p>
                  <p class="text-xs text-slate-500">Complete</p>
                </div>
              </div>
              <div class="h-2 bg-navy-700 rounded-full overflow-hidden">
                <div id="progress-bar" class="progress-fill h-full rounded-full" style="width: 0%"></div>
              </div>
              <div class="flex items-center justify-between mt-2">
                <div class="flex gap-1" id="section-dots">
                  <!-- Section completion dots injected here -->
                </div>
                <button onclick="exportPrompt()" id="copy-btn" class="hidden text-xs text-cyan-400 flex items-center gap-1">
                  <i class="fas fa-copy"></i> Copy Full Prompt
                </button>
              </div>
            </div>
            
            <!-- Mode toggle -->
            <div class="flex gap-2">
              <button onclick="setPromptMode('guided')" id="mode-guided"
                class="flex-1 py-2 text-xs font-semibold rounded-lg btn-primary">
                <i class="fas fa-hand-holding-heart mr-1"></i> Guided
              </button>
              <button onclick="setPromptMode('advanced')" id="mode-advanced"
                class="flex-1 py-2 text-xs font-semibold rounded-lg btn-ghost">
                <i class="fas fa-code mr-1"></i> Advanced
              </button>
            </div>
            
            <!-- Sections -->
            <div id="prompt-sections" class="space-y-3">
              <!-- Injected dynamically -->
            </div>
            
            <!-- Actions -->
            <div class="flex gap-3 pt-2">
              <button onclick="submitBuildRequest()" id="build-btn"
                class="flex-1 btn-primary py-4 rounded-xl font-semibold flex items-center justify-center gap-2">
                <i class="fas fa-hammer"></i>
                <span>Generate Build</span>
              </button>
            </div>
            
            <!-- Build cost preview -->
            <div id="build-cost-preview" class="glass rounded-xl p-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <i class="fas fa-info-circle text-slate-500 text-xs"></i>
                <span class="text-xs text-slate-400">Estimated cost for this build</span>
              </div>
              <span id="build-cost-amount" class="text-sm font-bold text-amber-400">-- coins</span>
            </div>
          </div>
        </div>
      </div>
      
      <!-- ACCOUNT PAGE -->
      <div id="page-account" class="page pt-4 space-y-4">
        <div class="animate-fade-up">
          <h2 class="text-xl font-bold text-white mb-4">Account</h2>
          
          <!-- Profile card -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center gap-4 mb-4">
              <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-black"
                   style="background: linear-gradient(135deg, #06b6d4, #fbbf24)" id="account-avatar">U</div>
              <div class="flex-1 min-w-0">
                <p id="account-name" class="text-base font-bold text-white truncate">User</p>
                <p id="account-email" class="text-xs text-slate-500 truncate">user@example.com</p>
                <span id="account-plan-badge" class="inline-block mt-1 text-xs font-semibold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded-full">Free Plan</span>
              </div>
              <button onclick="openEditProfile()" class="btn-ghost p-2 rounded-lg">
                <i class="fas fa-pen text-xs"></i>
              </button>
            </div>
            
            <div class="grid grid-cols-2 gap-3">
              <div>
                <p class="text-xs text-slate-500 mb-0.5">Email</p>
                <p id="account-email-display" class="text-xs font-medium text-slate-300 truncate">—</p>
              </div>
              <div>
                <p class="text-xs text-slate-500 mb-0.5">Phone</p>
                <p id="account-phone" class="text-xs font-medium text-slate-300">—</p>
              </div>
            </div>
          </div>
          
          <!-- Vault Summary -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <i class="fas fa-vault text-amber-400"></i>
                <p class="text-sm font-semibold text-white">Coin Vault</p>
              </div>
              <button onclick="openVaultModal()" class="text-xs text-cyan-400">View All</button>
            </div>
            <div class="flex items-end justify-between">
              <div>
                <p id="vault-balance" class="text-3xl font-black text-amber-400">0</p>
                <p class="text-xs text-slate-500 mt-0.5">Available Coins</p>
              </div>
              <button onclick="openBuyCoinModal()" class="btn-primary px-4 py-2 rounded-xl text-xs font-semibold">
                <i class="fas fa-plus mr-1"></i> Add Coins
              </button>
            </div>
            <div class="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between">
              <p class="text-xs text-slate-500">Monthly grant</p>
              <p id="vault-grant" class="text-xs font-semibold text-cyan-400">— coins / month</p>
            </div>
          </div>
          
          <!-- Plan Details -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <i class="fas fa-crown text-cyan-400"></i>
                <p class="text-sm font-semibold text-white">Membership</p>
              </div>
              <button onclick="openPlansModal()" class="text-xs text-cyan-400">Upgrade</button>
            </div>
            <div id="plan-details" class="space-y-2">
              <div class="flex justify-between text-xs">
                <span class="text-slate-500">Current plan</span>
                <span id="plan-name-display" class="font-semibold text-white capitalize">Free</span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-slate-500">Max projects</span>
                <span id="plan-max-projects" class="font-semibold text-slate-300">3</span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-slate-500">Max deployments</span>
                <span id="plan-max-deploys" class="font-semibold text-slate-300">1</span>
              </div>
            </div>
          </div>
          
          <!-- Security -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-shield-halved text-emerald-400"></i>
              <p class="text-sm font-semibold text-white">Security</p>
            </div>
            <div class="space-y-2">
              <button onclick="openChangePassword()" class="w-full flex items-center justify-between p-3 rounded-xl hover:bg-slate-800/50 transition-colors">
                <div class="flex items-center gap-3">
                  <i class="fas fa-lock text-slate-500 text-sm"></i>
                  <span class="text-sm text-slate-300">Change Password</span>
                </div>
                <i class="fas fa-chevron-right text-slate-600 text-xs"></i>
              </button>
              <button class="w-full flex items-center justify-between p-3 rounded-xl hover:bg-slate-800/50 transition-colors">
                <div class="flex items-center gap-3">
                  <i class="fas fa-mobile-screen text-slate-500 text-sm"></i>
                  <span class="text-sm text-slate-300">Two-Factor Auth</span>
                </div>
                <span class="text-xs text-slate-600">Coming soon</span>
              </button>
            </div>
          </div>
          
          <!-- Danger zone -->
          <div class="glass rounded-2xl p-5">
            <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Account Actions</p>
            <button onclick="handleLogout()" class="w-full flex items-center justify-between p-3 rounded-xl hover:bg-red-900/20 transition-colors group">
              <div class="flex items-center gap-3">
                <i class="fas fa-right-from-bracket text-red-500/70 text-sm"></i>
                <span class="text-sm text-slate-400 group-hover:text-red-400">Sign Out</span>
              </div>
            </button>
          </div>
        </div>
      </div>
      
      <!-- PLANNING PAGE (Kanban) — FULL SCREEN -->
      <div id="page-planning" class="page">
        <!-- Header bar -->
        <div class="flex items-center justify-between px-4 pt-4 pb-3 flex-shrink-0">
          <div>
            <h2 class="text-xl font-bold text-white">Planning Board</h2>
            <p class="text-xs text-slate-500 mt-0.5">Kanban · stay on track, ship faster</p>
          </div>
          <button onclick="openAddTaskModal()" class="btn-primary px-3 py-2 rounded-lg text-xs font-semibold">
            <i class="fas fa-plus mr-1"></i> Add Task
          </button>
        </div>

        <!-- Full-height board — columns fill vertical space -->
        <div class="flex gap-3 overflow-x-auto px-4 pb-2 flex-1" id="kanban-board"
             style="min-height:0;align-items:stretch">

          <!-- Column: Project To-Do -->
          <div class="kanban-col flex-shrink-0 rounded-2xl bg-slate-900/70 border border-slate-800/60 flex flex-col" style="width:calc(25% - 9px);min-width:220px" data-col="todo">
            <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-800/60 flex-shrink-0">
              <span class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
              <p class="text-sm font-bold text-white">Project To-Do</p>
              <span class="ml-auto text-xs text-slate-600 bg-slate-800 px-2 py-0.5 rounded-full" id="badge-todo">0</span>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2 kanban-cards" id="col-todo"
                 ondragover="onDragOver(event)" ondrop="onDrop(event,'todo')">
              <p class="text-xs text-slate-700 italic text-center py-4 empty-hint">Drag tasks here or tap + above</p>
            </div>
            <div class="p-3 border-t border-slate-800/40 flex-shrink-0">
              <button onclick="quickAddTask('todo')" class="w-full text-xs text-slate-600 hover:text-slate-400 flex items-center gap-1.5 transition-colors py-1">
                <i class="fas fa-plus-circle"></i> Add to Project To-Do
              </button>
            </div>
          </div>

          <!-- Column: Daily To-Do -->
          <div class="kanban-col flex-shrink-0 rounded-2xl bg-slate-900/70 border border-blue-500/20 flex flex-col" style="width:calc(25% - 9px);min-width:220px" data-col="daily">
            <div class="flex items-center gap-2 px-4 py-3 border-b border-blue-500/20 flex-shrink-0">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-400"></span>
              <p class="text-sm font-bold text-white">Daily To-Do</p>
              <span class="ml-auto text-xs text-blue-400/60 bg-blue-500/10 px-2 py-0.5 rounded-full" id="badge-daily">0</span>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2 kanban-cards" id="col-daily"
                 ondragover="onDragOver(event)" ondrop="onDrop(event,'daily')">
              <p class="text-xs text-slate-700 italic text-center py-4 empty-hint">Today's tasks</p>
            </div>
            <div class="p-3 border-t border-blue-500/10 flex-shrink-0">
              <button onclick="quickAddTask('daily')" class="w-full text-xs text-slate-600 hover:text-blue-400 flex items-center gap-1.5 transition-colors py-1">
                <i class="fas fa-plus-circle"></i> Add to Daily To-Do
              </button>
            </div>
          </div>

          <!-- Column: Doing -->
          <div class="kanban-col flex-shrink-0 rounded-2xl bg-slate-900/70 border border-amber-500/20 flex flex-col" style="width:calc(25% - 9px);min-width:220px" data-col="doing">
            <div class="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20 flex-shrink-0">
              <span class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse"></span>
              <p class="text-sm font-bold text-white">Doing</p>
              <span class="ml-auto text-xs text-amber-400/70 bg-amber-500/10 px-2 py-0.5 rounded-full" id="badge-doing">0</span>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2 kanban-cards" id="col-doing"
                 ondragover="onDragOver(event)" ondrop="onDrop(event,'doing')">
              <p class="text-xs text-slate-700 italic text-center py-4 empty-hint">In progress</p>
            </div>
            <div class="p-3 border-t border-amber-500/10 flex-shrink-0">
              <button onclick="quickAddTask('doing')" class="w-full text-xs text-slate-600 hover:text-amber-400 flex items-center gap-1.5 transition-colors py-1">
                <i class="fas fa-plus-circle"></i> Add to Doing
              </button>
            </div>
          </div>

          <!-- Column: Done -->
          <div class="kanban-col flex-shrink-0 rounded-2xl bg-slate-900/70 border border-emerald-500/20 flex flex-col" style="width:calc(25% - 9px);min-width:220px" data-col="done">
            <div class="flex items-center gap-2 px-4 py-3 border-b border-emerald-500/20 flex-shrink-0">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
              <p class="text-sm font-bold text-white">Done</p>
              <span class="ml-auto text-xs text-emerald-400/70 bg-emerald-500/10 px-2 py-0.5 rounded-full" id="badge-done">0</span>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2 kanban-cards" id="col-done"
                 ondragover="onDragOver(event)" ondrop="onDrop(event,'done')">
              <p class="text-xs text-slate-700 italic text-center py-4 empty-hint">Completed tasks</p>
            </div>
            <div class="p-3 border-t border-emerald-500/10 flex-shrink-0">
              <button onclick="clearDoneTasks()" class="w-full text-xs text-slate-600 hover:text-emerald-400 flex items-center gap-1.5 transition-colors py-1">
                <i class="fas fa-broom"></i> Clear Done
              </button>
            </div>
          </div>
        </div>

        <!-- Stats bar -->
        <div class="flex items-center justify-between px-4 pb-2 pt-2 flex-shrink-0" id="kanban-stats">
          <div class="flex items-center gap-4 text-xs text-slate-500">
            <span><span id="stat-total-tasks" class="font-bold text-white">0</span> total</span>
            <span><span id="stat-done-tasks" class="font-bold text-emerald-400">0</span> done</span>
          </div>
          <div id="kanban-velocity" class="text-xs text-slate-600 hidden">
            <i class="fas fa-fire text-amber-400 mr-1"></i>
            <span id="velocity-text"></span>
          </div>
        </div>
      </div>
      <!-- /PLANNING PAGE -->

      <!-- INFO PAGE / EDUCATION HUB -->
      <div id="page-info" class="page pt-4 pb-24">
        <div class="animate-fade-up">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-xl font-bold text-white">Learn & Help</h2>
              <p class="text-xs text-slate-500 mt-0.5">Guides, onboarding, FAQ, and coin economy</p>
            </div>
          </div>

          <!-- Onboarding progress bar -->
          <div class="glass rounded-xl p-4 mb-4">
            <div class="flex items-center justify-between mb-2">
              <p class="text-xs font-semibold text-white">Onboarding Progress</p>
              <p id="onboarding-progress-label" class="text-xs text-slate-500">0 / 7 steps</p>
            </div>
            <div class="h-1.5 bg-navy-700 rounded-full overflow-hidden">
              <div id="onboarding-progress-bar" class="progress-fill h-full rounded-full transition-all" style="width: 0%"></div>
            </div>
          </div>

          <!-- Tab navigation -->
          <div class="flex border-b border-slate-800 mb-4 gap-0 overflow-x-auto no-scrollbar">
            <button class="learn-tab-btn flex-1 py-2.5 text-xs font-semibold border-b-2 text-cyan-400 border-cyan-500 whitespace-nowrap px-2 transition-colors" data-tab="onboarding" onclick="setLearnTab('onboarding')">
              <i class="fas fa-graduation-cap mr-1"></i> Start
            </button>
            <button class="learn-tab-btn flex-1 py-2.5 text-xs font-semibold border-b-2 text-slate-500 border-transparent whitespace-nowrap px-2 transition-colors" data-tab="guides" onclick="setLearnTab('guides')">
              <i class="fas fa-book mr-1"></i> Guides
            </button>
            <button class="learn-tab-btn flex-1 py-2.5 text-xs font-semibold border-b-2 text-slate-500 border-transparent whitespace-nowrap px-2 transition-colors" data-tab="coins" onclick="setLearnTab('coins')">
              <i class="fas fa-coins mr-1"></i> Coins
            </button>
            <button class="learn-tab-btn flex-1 py-2.5 text-xs font-semibold border-b-2 text-slate-500 border-transparent whitespace-nowrap px-2 transition-colors" data-tab="faq" onclick="setLearnTab('faq')">
              <i class="fas fa-circle-question mr-1"></i> FAQ
            </button>
          </div>

          <!-- Onboarding tab -->
          <div class="learn-tab-pane" data-tab="onboarding">
            <p class="text-xs text-slate-500 mb-3">Complete these steps to get the most out of DEPLOY:</p>
            <div id="onboarding-steps-list" class="space-y-0">
              <!-- Populated by JS -->
              <div class="glass rounded-xl p-3 text-center py-6">
                <i class="fas fa-spinner fa-spin text-slate-600 text-xl mb-2 block"></i>
                <p class="text-slate-500 text-sm">Loading steps…</p>
              </div>
            </div>
          </div>

          <!-- Guides tab -->
          <div class="learn-tab-pane hidden" data-tab="guides">
            <div id="learn-guides-content">
              <p class="text-slate-500 text-sm text-center py-6">
                <i class="fas fa-spinner fa-spin mr-2"></i>Loading guides…
              </p>
            </div>
          </div>

          <!-- Coin Economy tab -->
          <div class="learn-tab-pane hidden" data-tab="coins">
            <div id="learn-coins-content">
              <p class="text-slate-500 text-sm text-center py-6">
                <i class="fas fa-spinner fa-spin mr-2"></i>Loading…
              </p>
            </div>
          </div>

          <!-- FAQ tab -->
          <div class="learn-tab-pane hidden" data-tab="faq">
            <div id="learn-faq-content">
              <p class="text-slate-500 text-sm text-center py-6">
                <i class="fas fa-spinner fa-spin mr-2"></i>Loading FAQ…
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
  
  <!-- Bottom Navigation -->
  <nav class="bottom-nav fixed bottom-0 left-0 right-0 z-40 safe-bottom">
    <div class="flex items-stretch max-w-2xl mx-auto">
      <button onclick="navigateTo('home')" class="nav-item active flex-1 flex flex-col items-center py-2.5 gap-0.5 relative" id="nav-home">
        <i class="nav-icon fas fa-house text-slate-500 text-base transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors" style="font-size:10px">Home</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('prompt')" class="nav-item flex-1 flex flex-col items-center py-2.5 gap-0.5 relative" id="nav-prompt">
        <i class="nav-icon fas fa-wand-magic-sparkles text-slate-500 text-base transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors" style="font-size:10px">Prompt</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('planning')" class="nav-item flex-1 flex flex-col items-center py-2.5 gap-0.5 relative" id="nav-planning">
        <i class="nav-icon fas fa-table-columns text-slate-500 text-base transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors" style="font-size:10px">Planning</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('account')" class="nav-item flex-1 flex flex-col items-center py-2.5 gap-0.5 relative" id="nav-account">
        <i class="nav-icon fas fa-user text-slate-500 text-base transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors" style="font-size:10px">Account</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('info')" class="nav-item flex-1 flex flex-col items-center py-2.5 gap-0.5 relative" id="nav-info">
        <i class="nav-icon fas fa-circle-info text-slate-500 text-base transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors" style="font-size:10px">Info</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
    </div>
  </nav>
</div>

<!-- ============================================================
     MODALS
     ============================================================ -->

<!-- New Project Modal -->
<div id="modal-new-project" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-new-project')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-6 space-y-4">
    <h3 class="text-base font-bold text-white">New Project</h3>
    <div>
      <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Project Name</label>
      <input id="new-project-name" type="text" placeholder="e.g. TaskFlow Pro" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Category</label>
      <select id="new-project-category" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
        <option value="">Select category...</option>
        <option value="saas">SaaS Platform</option>
        <option value="mobile">Mobile App</option>
        <option value="ecommerce">E-Commerce</option>
        <option value="dashboard">Dashboard / Analytics</option>
        <option value="api">API / Backend</option>
        <option value="marketplace">Marketplace</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Brief Description</label>
      <textarea id="new-project-desc" placeholder="What does this app do?" rows="2"
        class="deploy-input w-full px-4 py-3 rounded-xl text-sm resize-none"></textarea>
    </div>
    <div class="flex gap-3 pt-1">
      <button onclick="closeModal('modal-new-project')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button onclick="createProject()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">Create Project</button>
    </div>
  </div>
</div>

<!-- Model Selector Modal -->
<div id="modal-models" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-models')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white">Select AI Model</h3>
      <button onclick="closeModal('modal-models')" class="text-slate-500 hover:text-white">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
    <p class="text-xs text-slate-500">Switch model for your current project</p>
    <div id="model-list" class="space-y-2 max-h-80 overflow-y-auto">
      <div class="shimmer h-16 rounded-xl"></div>
      <div class="shimmer h-16 rounded-xl"></div>
    </div>
  </div>
</div>

<!-- Vault Modal -->
<div id="modal-vault" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-vault')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4 max-h-[80vh] overflow-y-auto">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white">
        <i class="fas fa-vault text-amber-400 mr-2"></i>Coin Vault
      </h3>
      <button onclick="closeModal('modal-vault')" class="text-slate-500 hover:text-white">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
    <div id="vault-full-content">
      <div class="shimmer h-32 rounded-xl"></div>
    </div>
  </div>
</div>

<!-- Buy Coins Modal -->
<div id="modal-buy-coins" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-buy-coins')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white"><i class="fas fa-coins text-amber-400 mr-2"></i>Add Coins</h3>
      <button onclick="closeModal('modal-buy-coins')" class="text-slate-500 hover:text-white">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
    <p class="text-xs text-slate-500">Select a package — you'll confirm payment before any charge.</p>
    <div id="coin-packages-list" class="space-y-2">
      <div class="shimmer h-16 rounded-xl"></div>
    </div>
  </div>
</div>

<!-- Payment Confirmation Modal -->
<div id="modal-pay-confirm" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closePayConfirm()"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white"><i class="fas fa-lock text-emerald-400 mr-2"></i>Confirm Purchase</h3>
      <button onclick="closePayConfirm()" class="text-slate-500 hover:text-white"><i class="fas fa-xmark"></i></button>
    </div>

    <!-- Order summary -->
    <div class="bg-slate-900/60 border border-slate-700/50 rounded-xl p-4">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-slate-400">Package</span>
        <span id="payconf-pkg-name" class="text-sm font-bold text-white">—</span>
      </div>
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-slate-400">Coins</span>
        <span id="payconf-coins" class="text-sm font-semibold text-amber-400">—</span>
      </div>
      <div class="border-t border-slate-700/50 pt-2 mt-2 flex justify-between items-center">
        <span class="text-sm font-bold text-white">Total</span>
        <span id="payconf-price" class="text-lg font-black text-white">—</span>
      </div>
    </div>

    <!-- Payment method section -->
    <div id="payconf-method-section">
      <!-- Filled dynamically: saved card OR "add card" prompt -->
    </div>

    <!-- CTA buttons -->
    <div id="payconf-actions" class="space-y-2">
      <!-- Filled dynamically -->
    </div>

    <!-- Security note -->
    <p class="text-center text-xs text-slate-600">
      <i class="fas fa-shield-halved text-emerald-500 mr-1"></i>
      Secured by Stripe · PCI DSS Compliant
    </p>
  </div>
</div>

<!-- Add Card Modal (Stripe Elements) -->
<div id="modal-add-card" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-add-card')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white"><i class="fas fa-credit-card text-cyan-400 mr-2"></i>Add Payment Card</h3>
      <button onclick="closeModal('modal-add-card')" class="text-slate-500 hover:text-white"><i class="fas fa-xmark"></i></button>
    </div>

    <!-- Stripe Elements mount point -->
    <div>
      <label class="text-xs font-medium text-slate-400 mb-2 block">Card details</label>
      <div id="stripe-card-element" class="deploy-input rounded-xl px-4 py-3.5 min-h-[44px]">
        <!-- Stripe.js injects the card field here -->
      </div>
      <div id="stripe-card-errors" class="text-red-400 text-xs mt-2 hidden"></div>
    </div>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" id="card-set-default" checked class="rounded accent-indigo-500">
      <span class="text-xs text-slate-400">Set as default payment method</span>
    </label>

    <div class="flex gap-3">
      <button onclick="closeModal('modal-add-card')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button id="btn-save-card" onclick="saveCardAndProceed()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">
        <i class="fas fa-lock mr-1"></i> Save Card
      </button>
    </div>

    <p class="text-center text-xs text-slate-600">
      <i class="fas fa-shield-halved text-emerald-500 mr-1"></i>
      Your card details go directly to Stripe — we never see or store them.
    </p>
  </div>
</div>

<!-- Plans Modal -->
<div id="modal-plans" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-plans')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white">Plans</h3>
      <button onclick="closeModal('modal-plans')" class="text-slate-500 hover:text-white">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
    <div id="plans-list" class="space-y-3"></div>
  </div>
</div>

<!-- Change Password Modal -->
<div id="modal-change-password" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-change-password')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <h3 class="text-base font-bold text-white">Change Password</h3>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Current Password</label>
      <input id="cp-current" type="password" class="deploy-input w-full px-4 py-3 rounded-xl text-sm" placeholder="••••••••">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">New Password</label>
      <input id="cp-new" type="password" class="deploy-input w-full px-4 py-3 rounded-xl text-sm" placeholder="Min 8 characters">
    </div>
    <div class="flex gap-3">
      <button onclick="closeModal('modal-change-password')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button onclick="submitChangePassword()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">Update</button>
    </div>
  </div>
</div>

<!-- Edit Profile Modal -->
<div id="modal-edit-profile" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-edit-profile')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <h3 class="text-base font-bold text-white">Edit Profile</h3>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Name</label>
      <input id="edit-name" type="text" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Phone</label>
      <input id="edit-phone" type="tel" class="deploy-input w-full px-4 py-3 rounded-xl text-sm" placeholder="+1 234 567 8900">
    </div>
    <div class="flex gap-3">
      <button onclick="closeModal('modal-edit-profile')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button onclick="submitEditProfile()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">Save</button>
    </div>
  </div>
</div>

<!-- ============================================================
     ADD TASK MODAL (Kanban)
     ============================================================ -->
<div id="modal-add-task" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-add-task')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white"><i class="fas fa-plus-circle text-cyan-400 mr-2"></i>Add Task</h3>
      <button onclick="closeModal('modal-add-task')" class="text-slate-500 hover:text-white"><i class="fas fa-xmark"></i></button>
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Task Title</label>
      <input id="task-title-input" type="text" placeholder="What needs to be done?" class="deploy-input w-full px-4 py-3 rounded-xl text-sm" maxlength="120">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Notes (optional)</label>
      <textarea id="task-notes-input" placeholder="Add more detail…" rows="2" class="deploy-input w-full px-4 py-3 rounded-xl text-sm resize-none"></textarea>
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Column</label>
      <select id="task-col-select" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
        <option value="todo">Project To-Do</option>
        <option value="daily">Daily To-Do</option>
        <option value="doing">Doing</option>
        <option value="done">Done</option>
      </select>
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Priority</label>
      <div class="flex gap-2" id="priority-picker">
        <button onclick="setPriority('low',this)" data-priority="low"
          class="flex-1 py-2 rounded-lg text-xs font-semibold border border-slate-700 text-slate-400 hover:border-slate-600 transition-all">
          Low
        </button>
        <button onclick="setPriority('medium',this)" data-priority="medium"
          class="flex-1 py-2 rounded-lg text-xs font-semibold border border-amber-500/60 bg-amber-500/10 text-amber-400 transition-all priority-selected">
          Medium
        </button>
        <button onclick="setPriority('high',this)" data-priority="high"
          class="flex-1 py-2 rounded-lg text-xs font-semibold border border-slate-700 text-slate-400 hover:border-slate-600 transition-all">
          High
        </button>
      </div>
    </div>
    <div class="flex gap-3 pt-1">
      <button onclick="closeModal('modal-add-task')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button onclick="saveTask()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">
        <i class="fas fa-plus mr-1"></i> Add Task
      </button>
    </div>
  </div>
</div>

<!-- ============================================================
     BUILD PREVIEW MODAL (Genspark-style real-time streaming)
     ============================================================ -->
<div id="modal-build-preview" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0"></div>
  <div class="relative w-full max-w-2xl bg-slate-900 rounded-3xl flex flex-col overflow-hidden border border-slate-700/60" style="max-height:90vh">
    <!-- Header -->
    <div class="flex-shrink-0 px-6 pt-5 pb-4 border-b border-slate-800">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#4f46e5)">
            <i class="fas fa-brain text-white text-sm"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">AI is Building Your App</h3>
            <p class="text-xs text-slate-400" id="preview-project-name">Initializing…</p>
          </div>
        </div>
        <!-- Live indicator -->
        <div class="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-full">
          <div class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
          <span class="text-xs font-semibold text-red-400">LIVE</span>
        </div>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="flex-shrink-0 px-6 py-4 border-b border-slate-800/60">
      <div class="flex items-center justify-between mb-2">
        <p class="text-sm font-semibold text-white" id="preview-status-text">Initializing AI engine…</p>
        <span class="text-xs text-slate-400" id="preview-step-counter">1 / 8</span>
      </div>
      <div class="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div id="preview-progress-bar" class="h-full rounded-full transition-all duration-500"
          style="width:5%;background:linear-gradient(90deg,#6366f1,#06b6d4)"></div>
      </div>
      <!-- Step dots -->
      <div class="flex gap-1.5 mt-3 justify-center">
        <div class="h-1 w-8 rounded-full bg-indigo-500" id="pstep-1"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-2"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-3"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-4"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-5"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-6"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-7"></div>
        <div class="h-1 w-8 rounded-full bg-slate-700" id="pstep-8"></div>
      </div>
    </div>

    <!-- Live output terminal -->
    <div class="flex-1 overflow-y-auto px-6 py-4 font-mono text-xs" id="preview-terminal"
      style="background:#0d1117;min-height:280px;max-height:380px">
      <div class="text-emerald-400 mb-2">$ deploy build --mode=ai --model=claude-3.5</div>
      <div id="preview-log-lines" class="space-y-0.5">
        <div class="text-slate-400 typing-line">Connecting to AI orchestration layer...</div>
      </div>
      <div id="preview-cursor" class="inline-block w-2 h-3.5 bg-emerald-400 animate-pulse ml-0.5"></div>
    </div>

    <!-- Bottom section -->
    <div class="flex-shrink-0 px-6 py-4 border-t border-slate-800">
      <div id="preview-complete-section" class="hidden">
        <div class="flex items-center gap-3 p-4 rounded-2xl border border-emerald-500/30 mb-4" style="background:rgba(16,185,129,0.08)">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-500">
            <i class="fas fa-check text-white text-sm"></i>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold text-white">Build Complete!</p>
            <p class="text-xs text-emerald-400" id="preview-readiness-score">Readiness: calculating...</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-slate-500">Build time</p>
            <p class="text-sm font-bold text-white" id="preview-build-time">--s</p>
          </div>
        </div>
        <button onclick="onBuildPreviewComplete()"
          class="w-full py-3.5 rounded-2xl text-sm font-bold text-white flex items-center justify-center gap-2"
          style="background:linear-gradient(135deg,#10b981,#059669)">
          <i class="fas fa-flask"></i> Open Testing &amp; Revisions
        </button>
      </div>
      <div id="preview-building-section">
        <div class="flex items-center gap-3 text-xs text-slate-500">
          <i class="fas fa-info-circle text-slate-600"></i>
          <span>Your coins are reserved until the build completes. If it fails, they're fully returned.</span>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ============================================================
     TESTING & REVISIONS MODAL (post-build)
     ============================================================ -->
<div id="modal-testing" class="hidden fixed inset-0 z-50 flex items-end justify-center p-0">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-testing')"></div>
  <div class="relative w-full max-w-2xl bg-slate-900 rounded-t-3xl flex flex-col overflow-hidden" style="max-height:92vh">
    <!-- Handle + Header -->
    <div class="flex-shrink-0 px-5 pt-4 pb-0">
      <div class="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-4"></div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#10b981,#059669)">
            <i class="fas fa-flask text-white text-sm"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Testing &amp; Revisions</h3>
            <p class="text-xs text-emerald-400" id="testing-build-name">Build ready</p>
          </div>
        </div>
        <button onclick="closeModal('modal-testing')" class="text-slate-500 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <!-- Tabs -->
      <div class="flex gap-1 bg-slate-800/60 p-1 rounded-xl mb-3">
        <button onclick="setTestingTab('summary')" id="ttab-summary"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all bg-slate-700 text-white">
          <i class="fas fa-file-lines mr-1"></i> Summary
        </button>
        <button onclick="setTestingTab('chat')" id="ttab-chat"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all text-slate-400">
          <i class="fas fa-comments mr-1"></i> AI Chat
        </button>
        <button onclick="setTestingTab('revisions')" id="ttab-revisions"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all text-slate-400">
          <i class="fas fa-pen-nib mr-1"></i> Revisions
        </button>
      </div>
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-y-auto px-5 pb-5">

      <!-- SUMMARY TAB -->
      <div id="testing-tab-summary" class="space-y-4">
        <div id="summary-content">
          <div class="shimmer h-40 rounded-2xl mb-3"></div>
          <div class="shimmer h-24 rounded-xl"></div>
        </div>
        <button onclick="generateBuildSummary()" id="btn-gen-summary"
          class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
          <i class="fas fa-wand-magic-sparkles"></i> Generate Summary
          <span class="text-xs opacity-70 ml-1">· 5 coins</span>
        </button>
      </div>

      <!-- AI CHAT TAB -->
      <div id="testing-tab-chat" class="hidden flex flex-col" style="min-height:300px">
        <div id="chat-messages" class="flex-1 space-y-3 mb-4 min-h-48 max-h-72 overflow-y-auto pr-1">
          <div class="flex gap-3">
            <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
              <i class="fas fa-robot text-white text-xs"></i>
            </div>
            <div class="bg-slate-800/60 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xs">
              <p class="text-sm text-slate-300">Hi! I've reviewed your build. Ask me anything about what was built, how features work, or what changes to make.</p>
            </div>
          </div>
        </div>
        <div class="flex gap-2 sticky bottom-0 pt-2 bg-slate-900">
          <input id="chat-input" type="text" placeholder="Ask about your build…"
            class="deploy-input flex-1 px-4 py-3 rounded-xl text-sm"
            onkeydown="if(event.key==='Enter')sendChatMessage()">
          <button onclick="sendChatMessage()"
            class="btn-primary px-4 py-3 rounded-xl text-sm font-semibold flex items-center gap-1.5">
            <i class="fas fa-paper-plane"></i>
          </button>
        </div>
        <p class="text-xs text-slate-600 mt-2 text-center">2 coins per message via Intent Layer</p>
      </div>

      <!-- REVISIONS TAB -->
      <div id="testing-tab-revisions" class="hidden space-y-4">
        <div class="glass rounded-xl p-4 border border-amber-500/20">
          <div class="flex items-start gap-2 mb-2">
            <i class="fas fa-circle-info text-amber-400 text-sm mt-0.5"></i>
            <p class="text-xs text-slate-400 leading-relaxed">Revisions use the <span class="text-amber-400 font-semibold">Intent Layer</span> — new logic is structured, not hardcoded. Each revision costs <strong class="text-white">10 coins</strong>.</p>
          </div>
        </div>
        <div id="revision-history" class="space-y-2 max-h-40 overflow-y-auto">
          <p class="text-xs text-slate-600 italic text-center py-2">No revisions yet</p>
        </div>
        <div>
          <label class="text-xs font-medium text-slate-400 mb-2 block uppercase tracking-wider">Describe your revision</label>
          <textarea id="revision-input" placeholder="What would you like to change? Be specific — e.g. 'Add a dark mode toggle to the header' or 'Change the checkout flow to show a confirmation screen'…"
            rows="4" class="deploy-input w-full px-4 py-3 rounded-xl text-sm resize-none"></textarea>
          <p id="revision-coin-preview" class="text-xs text-slate-600 mt-1.5 text-right">~10 coins</p>
        </div>
        <button onclick="submitRevision()" id="btn-submit-revision"
          class="btn-primary w-full py-4 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
          <i class="fas fa-wand-magic-sparkles"></i> Apply Revision
          <span class="text-xs opacity-70 ml-1">· 10 coins</span>
        </button>
        <button onclick="openPublishModal()" class="w-full py-3 rounded-xl text-sm font-semibold border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-2">
          <i class="fas fa-rocket"></i> Proceed to Publish
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ============================================================
     PUBLISH MODAL
     ============================================================ -->
<div id="modal-publish" class="hidden fixed inset-0 z-50 flex items-end justify-center p-0">
  <div class="modal-overlay absolute inset-0" onclick="closeModal('modal-publish')"></div>
  <div class="relative w-full max-w-2xl bg-slate-900 rounded-t-3xl flex flex-col overflow-hidden" style="max-height:95vh">
    <!-- Handle + Header -->
    <div class="flex-shrink-0 px-5 pt-4 pb-0">
      <div class="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-4"></div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#4f46e5)">
            <i class="fas fa-rocket text-white text-sm"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Publish Your App</h3>
            <p class="text-xs text-slate-400">Step-by-step publishing guide</p>
          </div>
        </div>
        <button onclick="closeModal('modal-publish')" class="text-slate-500 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <!-- Store Tabs -->
      <div class="flex gap-1 bg-slate-800/60 p-1 rounded-xl mb-3">
        <button onclick="setPublishTab('ios')" id="ptab-ios"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all bg-slate-700 text-white flex items-center justify-center gap-1.5">
          <i class="fab fa-apple"></i> App Store
        </button>
        <button onclick="setPublishTab('android')" id="ptab-android"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all text-slate-400 flex items-center justify-center gap-1.5">
          <i class="fab fa-google-play"></i> Google Play
        </button>
        <button onclick="setPublishTab('web')" id="ptab-web"
          class="flex-1 py-2 text-xs font-semibold rounded-lg transition-all text-slate-400 flex items-center justify-center gap-1.5">
          <i class="fas fa-globe"></i> Web
        </button>
      </div>
    </div>

    <!-- Tab content scroll -->
    <div class="flex-1 overflow-y-auto px-5 pb-6">

      <!-- iOS / App Store Tab -->
      <div id="publish-tab-ios" class="space-y-3">
        <div class="glass rounded-xl p-4 border border-slate-700/40">
          <p class="text-xs text-slate-400 leading-relaxed">Publishing to the App Store requires an <span class="text-white font-semibold">Apple Developer account ($99/yr)</span>. The steps below walk you through everything from setup to launch.</p>
        </div>
        <div id="ios-checklist" class="space-y-2"></div>
        <div class="glass rounded-xl p-4 border border-blue-500/20 mt-4">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-lightbulb text-blue-400 text-sm"></i>
            <p class="text-xs font-semibold text-white">Pro Tips</p>
          </div>
          <ul class="space-y-1.5 text-xs text-slate-400">
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Use TestFlight for beta testing before submission</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Screenshots must be for all required device sizes</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Review guidelines thoroughly — rejection is common for first submissions</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Average review time: 1-3 business days</li>
          </ul>
        </div>
        <a id="publish-cta-ios" href="https://developer.apple.com/programs/enroll/" target="_blank" rel="noopener"
          class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 mt-2">
          <i class="fab fa-apple"></i> Start Here: Create Apple Developer Account
          <i class="fas fa-arrow-up-right-from-square text-xs ml-1 opacity-60"></i>
        </a>
      </div>

      <!-- Android / Google Play Tab -->
      <div id="publish-tab-android" class="hidden space-y-3">
        <div class="glass rounded-xl p-4 border border-slate-700/40">
          <p class="text-xs text-slate-400 leading-relaxed">Publishing to Google Play requires a <span class="text-white font-semibold">Google Play Developer account ($25 one-time)</span>. Follow the checklist below to go from build to live app.</p>
        </div>
        <div id="android-checklist" class="space-y-2"></div>
        <div class="glass rounded-xl p-4 border border-green-500/20 mt-4">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-lightbulb text-green-400 text-sm"></i>
            <p class="text-xs font-semibold text-white">Pro Tips</p>
          </div>
          <ul class="space-y-1.5 text-xs text-slate-400">
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Use Internal Testing track first — only 100 testers</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>AAB (Android App Bundle) is required — not APK</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Data safety form is mandatory — review it carefully</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>First review can take 3-7 days; subsequent updates are faster</li>
          </ul>
        </div>
        <a id="publish-cta-android" href="https://play.google.com/console/signup" target="_blank" rel="noopener"
          class="w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 mt-2 border border-green-500/40 text-green-400 hover:bg-green-500/10 transition-colors">
          <i class="fab fa-google-play"></i> Start Here: Create Google Play Account
          <i class="fas fa-arrow-up-right-from-square text-xs ml-1 opacity-60"></i>
        </a>
      </div>

      <!-- Web Tab -->
      <div id="publish-tab-web" class="hidden space-y-3">
        <div class="glass rounded-xl p-4 border border-slate-700/40">
          <p class="text-xs text-slate-400 leading-relaxed">Deploy your web app to <span class="text-white font-semibold">Cloudflare Pages</span> — the fastest global edge network. Your app will be live at <code class="text-cyan-400">your-app.pages.dev</code> in minutes.</p>
        </div>
        <div id="web-checklist" class="space-y-2"></div>
        <div class="glass rounded-xl p-4 border border-cyan-500/20 mt-4">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-lightbulb text-cyan-400 text-sm"></i>
            <p class="text-xs font-semibold text-white">Pro Tips</p>
          </div>
          <ul class="space-y-1.5 text-xs text-slate-400">
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Add a custom domain in Cloudflare Pages settings</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Enable Analytics to track real users from day 1</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Set up environment variables for production keys</li>
            <li class="flex items-start gap-2"><i class="fas fa-check text-emerald-400 mt-0.5 flex-shrink-0"></i>Free tier includes unlimited requests and bandwidth</li>
          </ul>
        </div>
        <a id="publish-cta-web" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener"
          class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 mt-2">
          <i class="fas fa-rocket"></i> Start Here: Create Cloudflare Account
          <i class="fas fa-arrow-up-right-from-square text-xs ml-1 opacity-60"></i>
        </a>
      </div>

    </div>
  </div>
</div>

<!-- ============================================================
     VIEW PROJECT MODAL — Full-screen interactive prototype viewer
     Pure inline styles — does NOT depend on Tailwind CSS
     ============================================================ -->
<div id="modal-view" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#060912">
  <!-- Loading overlay — shown while generating dashboard -->
  <div id="view-loading" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;align-items:center;justify-content:center;background:#060912;z-index:1">
    <div style="text-align:center">
      <div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#06b6d4,#0891b2);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;box-shadow:0 8px 32px rgba(6,182,212,0.4)">
        <i class="fas fa-cube" style="color:white;font-size:24px"></i>
      </div>
      <p style="color:white;font-weight:700;font-size:18px;margin:0 0 6px;font-family:'Inter',sans-serif">Generating Preview…</p>
      <p style="color:#64748b;font-size:13px;margin:0 0 20px;font-family:'Inter',sans-serif">Building your unique interface</p>
      <div style="display:flex;justify-content:center;gap:6px">
        <div style="width:8px;height:8px;border-radius:50%;background:#06b6d4;animation:bounce 1s ease-in-out 0ms infinite"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:#06b6d4;animation:bounce 1s ease-in-out 150ms infinite"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:#06b6d4;animation:bounce 1s ease-in-out 300ms infinite"></div>
      </div>
    </div>
  </div>
  <!-- Dashboard content — injected by generateProjectDashboard() in app.js -->
  <div id="view-content" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;z-index:2"></div>
</div>

<!-- Scripts -->
<script src="https://js.stripe.com/v3/"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<script src="/static/app.js"></script>
</body>
</html>`;
}

// ============================================================
// ADMIN DASHBOARD HTML
// ============================================================
function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>DEPLOY Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            navy: { 950:'#050810', 900:'#0a0e1a', 800:'#0d1224', 700:'#111829', 600:'#162035', 500:'#1e2d4a' },
            cyan:  { 400:'#22d3ee', 500:'#06b6d4' },
            amber: { 400:'#fbbf24', 500:'#f59e0b' }
          },
          fontFamily: { sans:['Inter','system-ui','sans-serif'], mono:['JetBrains Mono','monospace'] }
        }
      }
    }
  </script>
  <style>
    * { -webkit-tap-highlight-color: transparent; }
    body { background:#0a0e1a; color:#e2e8f0; font-family:'Inter',sans-serif; min-height:100vh; }
    ::-webkit-scrollbar { width:4px; height:4px; }
    ::-webkit-scrollbar-track { background:#0d1224; }
    ::-webkit-scrollbar-thumb { background:#22d3ee33; border-radius:2px; }
    .glass { background:rgba(13,18,36,0.8); backdrop-filter:blur(12px); border:1px solid rgba(34,211,238,0.1); }
    .glass-hover:hover { background:rgba(13,18,36,0.95); border-color:rgba(34,211,238,0.25); }
    .gradient-text { background:linear-gradient(135deg,#22d3ee,#06b6d4,#fbbf24); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
    .btn-primary { background:linear-gradient(135deg,#06b6d4,#0891b2); color:white; transition:all 0.2s; }
    .btn-primary:hover { background:linear-gradient(135deg,#22d3ee,#06b6d4); box-shadow:0 0 20px rgba(34,211,238,0.3); }
    .btn-ghost { background:transparent; border:1px solid rgba(34,211,238,0.2); color:#94a3b8; transition:all 0.2s; }
    .btn-ghost:hover { border-color:rgba(34,211,238,0.5); color:#22d3ee; background:rgba(34,211,238,0.05); }
    .btn-danger { background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); color:#f87171; transition:all 0.2s; }
    .btn-danger:hover { background:rgba(239,68,68,0.25); }
    .deploy-input { background:rgba(13,18,36,0.8); border:1px solid rgba(34,211,238,0.15); color:#e2e8f0; transition:all 0.2s; }
    .deploy-input:focus { outline:none; border-color:rgba(34,211,238,0.5); box-shadow:0 0 0 3px rgba(34,211,238,0.1); }
    .deploy-input::placeholder { color:#475569; }
    .chip-active { background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); }
    .chip-suspended { background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); }
    .chip-admin { background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3); }
    .chip-pending { background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3); }
    .chip-running { background:rgba(34,211,238,0.15); color:#22d3ee; border:1px solid rgba(34,211,238,0.3); }
    .chip-completed { background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); }
    .chip-failed { background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); }
    .modal-overlay { background:rgba(5,8,16,0.9); backdrop-filter:blur(8px); }
    @keyframes fadeInUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
    @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    .animate-fade-up { animation:fadeInUp 0.35s ease forwards; }
    .shimmer { background:linear-gradient(90deg,#0d1224 25%,#162035 50%,#0d1224 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; }
    #toast-container { position:fixed; top:20px; right:20px; z-index:9999; pointer-events:none; }
    .toast { background:rgba(13,18,36,0.95); border:1px solid rgba(34,211,238,0.2); backdrop-filter:blur(12px); animation:fadeInUp 0.3s ease; pointer-events:auto; padding:12px 16px; border-radius:12px; display:flex; align-items:center; gap:10px; min-width:220px; margin-bottom:8px; }
    .toast.success { border-color:rgba(34,197,94,0.4); }
    .toast.error { border-color:rgba(239,68,68,0.4); }
    .sidebar-link { transition:all 0.2s; border-radius:0.75rem; border-left:3px solid transparent; }
    .sidebar-link:hover { background:rgba(34,211,238,0.06); color:#22d3ee; }
    .sidebar-link.active { background:rgba(34,211,238,0.1); color:#22d3ee; border-left-color:#22d3ee; }
    .table-row:hover { background:rgba(34,211,238,0.04); }
    #admin-login-screen { display:flex; }
    #admin-app-screen { display:none; }
  </style>
</head>
<body>
<div id="toast-container"></div>

<!-- ADMIN LOGIN -->
<div id="admin-login-screen" class="min-h-screen items-center justify-center p-4">
  <div class="w-full max-w-sm">
    <div class="text-center mb-10">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
           style="background:linear-gradient(135deg,#7c3aed,#6d28d9,#4f46e5)">
        <i class="fas fa-shield-halved text-white text-2xl"></i>
      </div>
      <h1 class="text-3xl font-black gradient-text tracking-tight">DEPLOY</h1>
      <p class="text-slate-500 text-sm mt-1">Admin Command Centre</p>
    </div>
    <div class="glass rounded-2xl p-6 space-y-4">
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Admin Email</label>
        <input id="admin-login-email" type="email" placeholder="admin@deployapp.io" autocomplete="username"
          class="deploy-input w-full px-4 py-3 rounded-xl text-sm" value="admin@deployapp.io">
      </div>
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">Password</label>
        <div class="relative">
          <input id="admin-login-password" type="password" placeholder="••••••••" autocomplete="current-password"
            class="deploy-input w-full px-4 py-3 rounded-xl text-sm pr-11">
          <button onclick="document.getElementById('admin-login-password').type = document.getElementById('admin-login-password').type === 'password' ? 'text' : 'password'"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
            <i class="fas fa-eye text-sm"></i>
          </button>
        </div>
      </div>
      <button onclick="adminLogin()" class="btn-primary w-full py-3.5 rounded-xl text-sm font-semibold">
        <i class="fas fa-lock-open mr-2"></i>Access Admin Panel
      </button>
      <p class="text-center text-xs text-slate-600">Restricted access. All actions are logged.</p>
    </div>
    <div class="mt-4 text-center">
      <a href="/" class="text-xs text-slate-600 hover:text-slate-400">← Back to App</a>
    </div>
  </div>
</div>

<!-- ADMIN APP -->
<div id="admin-app-screen" class="min-h-screen" style="display:none">
  <div class="flex min-h-screen">
  <!-- Sidebar -->
  <aside class="w-64 flex-shrink-0 glass border-r border-cyan-500/10 flex flex-col" style="min-height:100vh; position:fixed; left:0; top:0; bottom:0; z-index:20; overflow-y:auto;">
    <div class="p-6 border-b border-slate-800">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#7c3aed,#4f46e5)">
          <i class="fas fa-shield-halved text-white text-sm"></i>
        </div>
        <div>
          <p class="font-black text-white text-sm">DEPLOY</p>
          <p class="text-xs text-purple-400 font-medium">Admin Console</p>
        </div>
      </div>
    </div>
    <div class="px-4 py-3 border-b border-slate-800">
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center bg-purple-500/20">
          <i class="fas fa-user-shield text-purple-400 text-xs"></i>
        </div>
        <div>
          <p id="sidebar-admin-name" class="text-xs font-semibold text-white">Admin</p>
          <p id="sidebar-admin-email" class="text-xs text-slate-500 truncate" style="max-width:140px">—</p>
        </div>
      </div>
    </div>
    <nav class="flex-1 p-4 space-y-1">
      <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider px-3 mb-2">Overview</p>
      <button onclick="showPanel('dashboard')" id="nav-dashboard" class="sidebar-link active w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-chart-line w-4 text-center text-cyan-400"></i> Dashboard
      </button>
      <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider px-3 mt-4 mb-2">Users</p>
      <button onclick="showPanel('users')" id="nav-users" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-users w-4 text-center"></i> All Users
      </button>
      <button onclick="showPanel('logins')" id="nav-logins" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-right-to-bracket w-4 text-center"></i> Login History
      </button>
      <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider px-3 mt-4 mb-2">Finance</p>
      <button onclick="showPanel('revenue')" id="nav-revenue" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-dollar-sign w-4 text-center"></i> Revenue
      </button>
      <button onclick="showPanel('coins')" id="nav-coins" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-coins w-4 text-center"></i> Coin Ledger
      </button>
      <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider px-3 mt-4 mb-2">Platform</p>
      <button onclick="showPanel('builds')" id="nav-builds" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-hammer w-4 text-center"></i> Build Jobs
      </button>
      <button onclick="showPanel('audit')" id="nav-audit" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-scroll w-4 text-center"></i> Audit Log
      </button>
      <button onclick="showPanel('flags')" id="nav-flags" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-flag w-4 text-center"></i> Feature Flags
      </button>
      <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider px-3 mt-4 mb-2">Setup</p>
      <button onclick="showPanel('stripe')" id="nav-stripe" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fab fa-stripe-s w-4 text-center"></i> Stripe Setup
      </button>
      <button onclick="showPanel('apikeys')" id="nav-apikeys" class="sidebar-link w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-300">
        <i class="fas fa-key w-4 text-center"></i> API Keys Guide
      </button>
    </nav>
    <div class="p-4 border-t border-slate-800">
      <button onclick="adminLogout()" class="btn-ghost w-full py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-2">
        <i class="fas fa-right-from-bracket text-xs"></i> Sign Out
      </button>
    </div>
  </aside>
  
  <!-- Main Content -->
  <div class="flex-1" style="margin-left:256px">
    <header class="sticky top-0 z-10 glass border-b border-slate-800 px-8 py-4 flex items-center justify-between">
      <div>
        <h1 id="panel-title" class="text-lg font-bold text-white">Dashboard</h1>
        <p id="panel-subtitle" class="text-xs text-slate-500">Platform overview</p>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="refreshCurrentPanel()" class="btn-ghost px-3 py-2 rounded-lg text-xs font-medium">
          <i class="fas fa-rotate-right mr-1.5"></i>Refresh
        </button>
        <a href="/" target="_blank" class="btn-ghost px-3 py-2 rounded-lg text-xs font-medium">
          <i class="fas fa-arrow-up-right-from-square mr-1.5"></i>Open App
        </a>
      </div>
    </header>
    
    <div class="p-8">

      <!-- DASHBOARD PANEL -->
      <div id="panel-dashboard" class="space-y-6 animate-fade-up">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4" id="stat-grid">
          <div class="shimmer h-28 rounded-2xl"></div><div class="shimmer h-28 rounded-2xl"></div>
          <div class="shimmer h-28 rounded-2xl"></div><div class="shimmer h-28 rounded-2xl"></div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4" id="stat-grid-2">
          <div class="shimmer h-28 rounded-2xl"></div><div class="shimmer h-28 rounded-2xl"></div>
          <div class="shimmer h-28 rounded-2xl"></div><div class="shimmer h-28 rounded-2xl"></div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="glass rounded-2xl p-5">
            <h3 class="text-sm font-bold text-white mb-4 flex items-center gap-2"><i class="fas fa-users text-cyan-400"></i> Recent Users</h3>
            <div id="dash-recent-users" class="space-y-2"><div class="shimmer h-10 rounded-xl"></div><div class="shimmer h-10 rounded-xl"></div><div class="shimmer h-10 rounded-xl"></div></div>
          </div>
          <div class="glass rounded-2xl p-5">
            <h3 class="text-sm font-bold text-white mb-4 flex items-center gap-2"><i class="fas fa-hammer text-amber-400"></i> Recent Builds</h3>
            <div id="dash-recent-builds" class="space-y-2"><div class="shimmer h-10 rounded-xl"></div><div class="shimmer h-10 rounded-xl"></div><div class="shimmer h-10 rounded-xl"></div></div>
          </div>
        </div>
      </div>

      <!-- USERS PANEL -->
      <div id="panel-users" class="hidden space-y-5">
        <div class="flex flex-wrap gap-3">
          <input id="user-search" type="text" placeholder="Search by email or name…" class="deploy-input flex-1 px-4 py-2.5 rounded-xl text-sm" style="min-width:200px" oninput="debounceSearch()">
          <select id="user-status-filter" class="deploy-input px-4 py-2.5 rounded-xl text-sm" onchange="usersPage=1;loadUsers()">
            <option value="">All Status</option><option value="active">Active</option><option value="suspended">Suspended</option>
          </select>
          <select id="user-plan-filter" class="deploy-input px-4 py-2.5 rounded-xl text-sm" onchange="usersPage=1;loadUsers()">
            <option value="">All Plans</option><option value="free">Free</option><option value="member">Member</option><option value="pro">Pro</option><option value="team">Team</option>
          </select>
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">User</th><th class="text-left px-3 py-3">Plan</th>
                <th class="text-left px-3 py-3">Status</th><th class="text-right px-3 py-3">Coins</th>
                <th class="text-right px-3 py-3">Projects</th><th class="text-right px-3 py-3">Last Login</th>
                <th class="text-right px-5 py-3">Actions</th>
              </tr></thead>
              <tbody id="users-table-body"><tr><td colspan="7" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="users-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="users-prev" onclick="usersPage--;loadUsers()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="users-next" onclick="usersPage++;loadUsers()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- LOGIN HISTORY PANEL -->
      <div id="panel-logins" class="hidden space-y-5">
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">User</th><th class="text-left px-3 py-3">Role</th>
                <th class="text-left px-3 py-3">IP Address</th><th class="text-left px-3 py-3">Device</th>
                <th class="text-right px-5 py-3">Time</th>
              </tr></thead>
              <tbody id="logins-table-body"><tr><td colspan="5" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="logins-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="logins-prev" onclick="loginsPage--;loadLogins()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="logins-next" onclick="loginsPage++;loadLogins()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- REVENUE PANEL -->
      <div id="panel-revenue" class="hidden space-y-5">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4" id="revenue-stats">
          <div class="shimmer h-24 rounded-2xl"></div><div class="shimmer h-24 rounded-2xl"></div><div class="shimmer h-24 rounded-2xl"></div>
        </div>
        <div class="glass rounded-2xl p-5">
          <h3 class="text-sm font-bold text-white mb-2">💳 How You Receive Payments</h3>
          <p class="text-xs text-slate-400 mb-3">Stripe collects from users and deposits to your bank account automatically.</p>
          <div class="space-y-1.5 text-xs text-slate-400 mb-4">
            <div class="flex gap-2"><span class="text-cyan-400 font-bold">1.</span><span>User pays via Stripe → funds held in your Stripe balance</span></div>
            <div class="flex gap-2"><span class="text-cyan-400 font-bold">2.</span><span>Stripe deducts 2.9% + $0.30 processing fee per transaction</span></div>
            <div class="flex gap-2"><span class="text-cyan-400 font-bold">3.</span><span>Net amount automatically deposited to your linked bank account</span></div>
            <div class="flex gap-2"><span class="text-cyan-400 font-bold">4.</span><span>Payouts: T+2 business days (US) — configurable in Stripe Dashboard</span></div>
          </div>
          <a href="https://dashboard.stripe.com" target="_blank" class="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold">
            <i class="fab fa-stripe-s"></i> Open Stripe Dashboard
          </a>
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">User</th><th class="text-left px-3 py-3">Type</th>
                <th class="text-left px-3 py-3">Status</th><th class="text-right px-3 py-3">Coins</th>
                <th class="text-right px-3 py-3">Amount</th><th class="text-right px-5 py-3">Date</th>
              </tr></thead>
              <tbody id="revenue-table-body"><tr><td colspan="6" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="revenue-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="revenue-prev" onclick="revenuePage--;loadRevenue()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="revenue-next" onclick="revenuePage++;loadRevenue()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- COINS PANEL -->
      <div id="panel-coins" class="hidden space-y-5">
        <div class="flex gap-3">
          <select id="coin-type-filter" class="deploy-input px-4 py-2.5 rounded-xl text-sm" onchange="coinsPage=1;loadCoins()">
            <option value="">All Types</option><option value="credit">Credit</option><option value="debit">Debit</option>
            <option value="hold">Hold</option><option value="release">Release</option><option value="admin_adjust">Admin Adjust</option>
          </select>
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">User</th><th class="text-left px-3 py-3">Type</th>
                <th class="text-right px-3 py-3">Amount</th><th class="text-right px-3 py-3">Balance After</th>
                <th class="text-left px-3 py-3">Description</th><th class="text-right px-5 py-3">Date</th>
              </tr></thead>
              <tbody id="coins-table-body"><tr><td colspan="6" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="coins-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="coins-prev" onclick="coinsPage--;loadCoins()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="coins-next" onclick="coinsPage++;loadCoins()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- BUILDS PANEL -->
      <div id="panel-builds" class="hidden space-y-5">
        <div class="flex gap-3">
          <select id="build-status-filter" class="deploy-input px-4 py-2.5 rounded-xl text-sm" onchange="buildsPage=1;loadBuilds()">
            <option value="">All Status</option><option value="running">Running</option>
            <option value="completed">Completed</option><option value="failed">Failed</option><option value="pending">Pending</option>
          </select>
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">User</th><th class="text-left px-3 py-3">Project</th>
                <th class="text-left px-3 py-3">Model</th><th class="text-left px-3 py-3">Status</th>
                <th class="text-right px-3 py-3">Coins</th><th class="text-right px-5 py-3">Date</th>
              </tr></thead>
              <tbody id="builds-table-body"><tr><td colspan="6" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="builds-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="builds-prev" onclick="buildsPage--;loadBuilds()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="builds-next" onclick="buildsPage++;loadBuilds()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- AUDIT LOG PANEL -->
      <div id="panel-audit" class="hidden space-y-5">
        <div class="flex gap-3">
          <input id="audit-action-filter" type="text" placeholder="Filter by action…" class="deploy-input flex-1 px-4 py-2.5 rounded-xl text-sm" oninput="debounceAudit()">
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr class="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                <th class="text-left px-5 py-3">Action</th><th class="text-left px-3 py-3">User</th>
                <th class="text-left px-3 py-3">Entity</th><th class="text-left px-3 py-3">IP</th>
                <th class="text-right px-5 py-3">Date</th>
              </tr></thead>
              <tbody id="audit-table-body"><tr><td colspan="5" class="text-center py-12 text-slate-500">Loading…</td></tr></tbody>
            </table>
          </div>
          <div class="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
            <p id="audit-count" class="text-xs text-slate-500">—</p>
            <div class="flex gap-2">
              <button id="audit-prev" onclick="auditPage--;loadAudit()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>← Prev</button>
              <button id="audit-next" onclick="auditPage++;loadAudit()" class="btn-ghost px-3 py-1.5 rounded-lg text-xs" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- FEATURE FLAGS PANEL -->
      <div id="panel-flags" class="hidden space-y-5">
        <div class="glass rounded-2xl p-5">
          <p class="text-xs text-slate-500 mb-4">Toggle platform features globally. Changes take effect immediately.</p>
          <div id="flags-list" class="space-y-3">
            <div class="shimmer h-14 rounded-xl"></div><div class="shimmer h-14 rounded-xl"></div>
          </div>
        </div>
      </div>

      <!-- STRIPE SETUP PANEL -->
      <div id="panel-stripe" class="hidden space-y-5">
        <div class="glass rounded-2xl p-6 space-y-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#635bff,#4f46e5)">
              <i class="fab fa-stripe-s text-white text-lg"></i>
            </div>
            <div><h3 class="text-base font-bold text-white">Stripe Payment Setup</h3><p class="text-xs text-slate-400">Connect your bank account to receive payments</p></div>
          </div>
          <div class="space-y-3">
            <div class="glass rounded-xl p-4" style="border-left:4px solid #22d3ee">
              <p class="text-sm font-semibold text-white mb-1">Step 1: Create a Stripe Account</p>
              <p class="text-xs text-slate-400 mb-2">Go to stripe.com and create a business account. Verify your identity and add your business details.</p>
              <a href="https://stripe.com/register" target="_blank" class="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"><i class="fas fa-external-link-alt"></i> Create Stripe Account</a>
            </div>
            <div class="glass rounded-xl p-4" style="border-left:4px solid #a855f7">
              <p class="text-sm font-semibold text-white mb-1">Step 2: Connect Your Bank Account</p>
              <p class="text-xs text-slate-400 mb-2">In Stripe Dashboard → Settings → Bank accounts → Add a bank account. Stripe verifies with micro-deposits (1–2 business days).</p>
              <a href="https://dashboard.stripe.com/settings/payouts" target="_blank" class="btn-ghost inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"><i class="fas fa-university"></i> Stripe Payout Settings</a>
            </div>
            <div class="glass rounded-xl p-4" style="border-left:4px solid #fbbf24">
              <p class="text-sm font-semibold text-white mb-1">Step 3: Get Your API Keys</p>
              <p class="text-xs text-slate-400 mb-3">Stripe Dashboard → Developers → API keys. Copy Secret Key, Publishable Key, and Webhook Secret.</p>
              <div class="space-y-2">
                <div class="bg-navy-800 rounded-lg px-3 py-2 font-mono text-xs text-cyan-400" style="background:#0d1224">STRIPE_SECRET_KEY=sk_live_...</div>
                <div class="bg-navy-800 rounded-lg px-3 py-2 font-mono text-xs text-cyan-400" style="background:#0d1224">STRIPE_PUBLISHABLE_KEY=pk_live_...</div>
                <div class="bg-navy-800 rounded-lg px-3 py-2 font-mono text-xs text-cyan-400" style="background:#0d1224">STRIPE_WEBHOOK_SECRET=whsec_...</div>
              </div>
            </div>
            <div class="glass rounded-xl p-4" style="border-left:4px solid #4ade80">
              <p class="text-sm font-semibold text-white mb-1">Step 4: Set Keys as Cloudflare Secrets</p>
              <p class="text-xs text-slate-400 mb-3">Run these from your terminal to securely store keys in Cloudflare Pages:</p>
              <div class="font-mono text-xs text-slate-300 rounded-xl p-3 space-y-1" style="background:#0d1224">
                <div>npx wrangler pages secret put STRIPE_SECRET_KEY</div>
                <div>npx wrangler pages secret put STRIPE_WEBHOOK_SECRET</div>
                <div>npx wrangler pages secret put JWT_SECRET</div>
                <div>npx wrangler pages secret put OPENAI_API_KEY</div>
                <div>npx wrangler pages secret put ANTHROPIC_API_KEY</div>
              </div>
            </div>
            <div class="glass rounded-xl p-4" style="border-left:4px solid #475569">
              <p class="text-sm font-semibold text-white mb-2">Stripe Fee Structure</p>
              <div class="space-y-1 text-xs text-slate-400">
                <div class="flex justify-between"><span>Card transactions</span><span class="text-white font-semibold">2.9% + $0.30</span></div>
                <div class="flex justify-between"><span>International cards</span><span class="text-white font-semibold">+1.5%</span></div>
                <div class="flex justify-between"><span>Payout timing (US)</span><span class="text-white font-semibold">T+2 business days</span></div>
                <div class="flex justify-between"><span>Minimum payout</span><span class="text-white font-semibold">$1.00</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- API KEYS GUIDE PANEL -->
      <div id="panel-apikeys" class="hidden space-y-5">
        <div class="glass rounded-2xl p-6">
          <h3 class="text-base font-bold text-white mb-1">Full API Key Requirements</h3>
          <p class="text-xs text-slate-400 mb-5">Every key needed to make DEPLOY fully operational.</p>
          <div class="space-y-3" id="apikeys-list"></div>
        </div>
      </div>

    </div>
  </div><!-- /flex-1 -->
  </div><!-- /flex -->
</div><!-- /admin-app-screen -->

<!-- USER DETAIL MODAL -->
<div id="modal-user" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeAdminModal('modal-user')"></div>
  <div class="relative w-full max-w-md glass rounded-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white">User Details</h3>
      <button onclick="closeAdminModal('modal-user')" class="text-slate-500 hover:text-white"><i class="fas fa-xmark"></i></button>
    </div>
    <div id="modal-user-content"></div>
  </div>
</div>

<!-- COIN ADJUST MODAL -->
<div id="modal-coin-adjust" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
  <div class="modal-overlay absolute inset-0" onclick="closeAdminModal('modal-coin-adjust')"></div>
  <div class="relative w-full max-w-sm glass rounded-2xl p-6 space-y-4">
    <h3 class="text-base font-bold text-white">Adjust Coins</h3>
    <p id="coin-adjust-user-label" class="text-xs text-slate-400">User: —</p>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Amount (+ to credit, - to debit)</label>
      <input id="coin-adjust-amount" type="number" placeholder="e.g. 100 or -50" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
    </div>
    <div>
      <label class="text-xs font-medium text-slate-400 mb-1.5 block">Reason</label>
      <input id="coin-adjust-reason" type="text" placeholder="e.g. Refund for failed build" class="deploy-input w-full px-4 py-3 rounded-xl text-sm">
    </div>
    <div class="flex gap-3">
      <button onclick="closeAdminModal('modal-coin-adjust')" class="btn-ghost flex-1 py-3 rounded-xl text-sm font-semibold">Cancel</button>
      <button onclick="submitCoinAdjust()" class="btn-primary flex-1 py-3 rounded-xl text-sm font-semibold">Apply</button>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<script src="/static/admin.js"></script>
</body>
</html>`;
}

export default app;
