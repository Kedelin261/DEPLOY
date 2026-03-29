// DEPLOY Platform - Main Application Entry Point
// Built on Hono + Cloudflare Workers/Pages

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/cloudflare-workers';
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
// ============================================================
app.use('/static/*', serveStatic({ root: './' }));
app.use('/favicon.ico', serveStatic({ path: './favicon.ico' }));

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

// Health check
app.get('/api/health', (c) => {
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
  <main class="flex-1 pb-24 overflow-y-auto">
    <div class="max-w-2xl mx-auto px-4">
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
          
          <!-- Quick stats row -->
          <div class="grid grid-cols-3 gap-3">
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-coins" class="text-lg font-black text-amber-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Coins</p>
            </div>
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-projects" class="text-lg font-black text-cyan-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Projects</p>
            </div>
            <div class="glass rounded-xl p-3 text-center">
              <p id="stat-deploys" class="text-lg font-black text-emerald-400">0</p>
              <p class="text-xs text-slate-500 mt-0.5">Deployed</p>
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
      
      <!-- INFO PAGE -->
      <div id="page-info" class="page pt-4 space-y-4">
        <div class="animate-fade-up">
          <h2 class="text-xl font-bold text-white mb-1">How DEPLOY Works</h2>
          <p class="text-slate-500 text-sm mb-5">Everything you need to know to build your first app</p>
          
          <!-- What is DEPLOY -->
          <div class="glass rounded-2xl p-5 space-y-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-lg flex items-center justify-center"
                   style="background: linear-gradient(135deg, #06b6d4, #0891b2)">
                <i class="fas fa-rocket text-white text-xs"></i>
              </div>
              <h3 class="text-sm font-bold text-white">What is DEPLOY?</h3>
            </div>
            <p class="text-sm text-slate-400 leading-relaxed">DEPLOY is an AI-powered app builder that turns your ideas, descriptions, and plans into structured software builds and deployment-ready products — without requiring you to write a single line of code.</p>
            <p class="text-sm text-slate-400 leading-relaxed">Designed for <span class="text-cyan-400">founders, consultants, and operators</span> who have great ideas but want AI to do the heavy lifting on architecture, planning, and implementation.</p>
          </div>
          
          <!-- The Workflow -->
          <div class="glass rounded-2xl p-5">
            <h3 class="text-sm font-bold text-white mb-4">The Workflow</h3>
            <div class="space-y-4">
              <div class="flex gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
                     style="background: linear-gradient(135deg, #06b6d4, #0891b2)">1</div>
                <div>
                  <p class="text-sm font-semibold text-white">Create a Project</p>
                  <p class="text-xs text-slate-500 mt-0.5">Name your app and set its category. This is your workspace.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
                     style="background: linear-gradient(135deg, #06b6d4, #0891b2)">2</div>
                <div>
                  <p class="text-sm font-semibold text-white">Fill the Prompt Builder</p>
                  <p class="text-xs text-slate-500 mt-0.5">Answer guided questions about your app — audience, features, tech, business model. Use AI Assist to fill fields faster.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
                     style="background: linear-gradient(135deg, #06b6d4, #0891b2)">3</div>
                <div>
                  <p class="text-sm font-semibold text-white">Choose Your AI Model</p>
                  <p class="text-xs text-slate-500 mt-0.5">Select the AI model for your build. Higher tier models produce more detailed, production-safe specs.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
                     style="background: linear-gradient(135deg, #fbbf24, #f59e0b)">4</div>
                <div>
                  <p class="text-sm font-semibold text-white">Generate Your Build</p>
                  <p class="text-xs text-slate-500 mt-0.5">Submit your prompt. Coins are held, the AI generates your product spec, architecture, and deployment plan.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
                     style="background: linear-gradient(135deg, #4ade80, #22c55e)">5</div>
                <div>
                  <p class="text-sm font-semibold text-white">Deploy</p>
                  <p class="text-xs text-slate-500 mt-0.5">Trigger a deployment to Cloudflare Pages. Get a live URL for your app.</p>
                </div>
              </div>
            </div>
          </div>
          
          <!-- How Coins Work -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-coins text-amber-400"></i>
              <h3 class="text-sm font-bold text-white">How Coins Work</h3>
            </div>
            <div class="space-y-2 text-sm text-slate-400">
              <p>Coins are DEPLOY's usage currency. Every AI action costs coins:</p>
              <div class="space-y-1.5 mt-3">
                <div class="flex justify-between">
                  <span>AI Assist (single field)</span>
                  <span class="text-amber-400 font-semibold">2 coins</span>
                </div>
                <div class="flex justify-between">
                  <span>Full Build (GPT-4o Mini)</span>
                  <span class="text-amber-400 font-semibold">~15 coins</span>
                </div>
                <div class="flex justify-between">
                  <span>Full Build (GPT-4o)</span>
                  <span class="text-amber-400 font-semibold">~45 coins</span>
                </div>
                <div class="flex justify-between">
                  <span>Revision Request</span>
                  <span class="text-amber-400 font-semibold">~10 coins</span>
                </div>
                <div class="flex justify-between">
                  <span>Deployment</span>
                  <span class="text-amber-400 font-semibold">15 coins</span>
                </div>
              </div>
              <p class="mt-3 text-xs text-slate-500">Coins are held when a job starts and settled on success. If a build fails, your coins are returned automatically.</p>
            </div>
          </div>
          
          <!-- Model Switching -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-robot text-cyan-400"></i>
              <h3 class="text-sm font-bold text-white">Model Switching</h3>
            </div>
            <p class="text-sm text-slate-400">Use the model selector in the top bar to switch AI models. Each model has different capabilities and coin costs:</p>
            <div class="mt-3 space-y-2">
              <div class="flex items-center gap-2 text-xs">
                <span class="tag-fast px-2 py-0.5 rounded-full font-medium">fast</span>
                <span class="text-slate-500">Quick responses, lower cost</span>
              </div>
              <div class="flex items-center gap-2 text-xs">
                <span class="tag-premium px-2 py-0.5 rounded-full font-medium">premium</span>
                <span class="text-slate-500">Best quality, higher coin cost</span>
              </div>
              <div class="flex items-center gap-2 text-xs">
                <span class="tag-reasoning px-2 py-0.5 rounded-full font-medium">reasoning</span>
                <span class="text-slate-500">Deep analysis, complex architecture</span>
              </div>
            </div>
          </div>
          
          <!-- FAQ -->
          <div class="glass rounded-2xl p-5">
            <h3 class="text-sm font-bold text-white mb-4">FAQ</h3>
            <div class="space-y-3" id="faq-list">
              <div class="border-b border-slate-800 pb-3">
                <button onclick="toggleFaq(this)" class="w-full text-left text-sm font-medium text-slate-300 flex justify-between items-start gap-2">
                  <span>Do I need to know how to code?</span>
                  <i class="fas fa-plus text-slate-600 text-xs mt-1 flex-shrink-0"></i>
                </button>
                <p class="faq-answer hidden mt-2 text-xs text-slate-500">No. DEPLOY is designed for non-technical founders and operators. The AI handles all the architecture and implementation planning.</p>
              </div>
              <div class="border-b border-slate-800 pb-3">
                <button onclick="toggleFaq(this)" class="w-full text-left text-sm font-medium text-slate-300 flex justify-between items-start gap-2">
                  <span>What does a "build" produce?</span>
                  <i class="fas fa-plus text-slate-600 text-xs mt-1 flex-shrink-0"></i>
                </button>
                <p class="faq-answer hidden mt-2 text-xs text-slate-500">A build produces a complete product specification: feature map, screen map, data model, API contracts, deployment plan, and implementation guidance — ready for a developer or another AI system to execute.</p>
              </div>
              <div class="border-b border-slate-800 pb-3">
                <button onclick="toggleFaq(this)" class="w-full text-left text-sm font-medium text-slate-300 flex justify-between items-start gap-2">
                  <span>Can I get coins back if a build fails?</span>
                  <i class="fas fa-plus text-slate-600 text-xs mt-1 flex-shrink-0"></i>
                </button>
                <p class="faq-answer hidden mt-2 text-xs text-slate-500">Yes. Coins are held (not spent) when a build starts. If the build fails for any reason, all held coins are automatically returned to your vault.</p>
              </div>
              <div class="border-b border-slate-800 pb-3">
                <button onclick="toggleFaq(this)" class="w-full text-left text-sm font-medium text-slate-300 flex justify-between items-start gap-2">
                  <span>Do I enter my own AI API keys?</span>
                  <i class="fas fa-plus text-slate-600 text-xs mt-1 flex-shrink-0"></i>
                </button>
                <p class="faq-answer hidden mt-2 text-xs text-slate-500">Never. DEPLOY manages all AI provider keys server-side. You access AI capabilities through coins — no API key setup, no provider accounts needed.</p>
              </div>
              <div>
                <button onclick="toggleFaq(this)" class="w-full text-left text-sm font-medium text-slate-300 flex justify-between items-start gap-2">
                  <span>What happens to my coins if I downgrade?</span>
                  <i class="fas fa-plus text-slate-600 text-xs mt-1 flex-shrink-0"></i>
                </button>
                <p class="faq-answer hidden mt-2 text-xs text-slate-500">Purchased coins never expire. Monthly grant coins follow your plan's rollover rules. When you downgrade, you keep your earned coin balance.</p>
              </div>
            </div>
          </div>
          
          <!-- Support -->
          <div class="glass rounded-2xl p-5">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-headset text-slate-400"></i>
              <h3 class="text-sm font-bold text-white">Need Help?</h3>
            </div>
            <div class="space-y-2">
              <button class="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-800/40 transition-colors">
                <i class="fas fa-envelope text-slate-500 text-sm"></i>
                <span class="text-sm text-slate-400">support@deployapp.io</span>
              </button>
              <button class="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-800/40 transition-colors">
                <i class="fab fa-twitter text-slate-500 text-sm"></i>
                <span class="text-sm text-slate-400">@deployapp</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
  
  <!-- Bottom Navigation -->
  <nav class="bottom-nav fixed bottom-0 left-0 right-0 z-40 safe-bottom">
    <div class="flex items-stretch max-w-2xl mx-auto">
      <button onclick="navigateTo('home')" class="nav-item active flex-1 flex flex-col items-center py-3 gap-1 relative" id="nav-home">
        <i class="nav-icon fas fa-house text-slate-500 text-lg transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors">Home</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('prompt')" class="nav-item flex-1 flex flex-col items-center py-3 gap-1 relative" id="nav-prompt">
        <i class="nav-icon fas fa-wand-magic-sparkles text-slate-500 text-lg transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors">Prompt</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('account')" class="nav-item flex-1 flex flex-col items-center py-3 gap-1 relative" id="nav-account">
        <i class="nav-icon fas fa-user text-slate-500 text-lg transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors">Account</span>
        <span class="nav-dot absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-cyan-400 rounded-full"></span>
      </button>
      <button onclick="navigateTo('info')" class="nav-item flex-1 flex flex-col items-center py-3 gap-1 relative" id="nav-info">
        <i class="nav-icon fas fa-circle-info text-slate-500 text-lg transition-colors"></i>
        <span class="text-xs font-medium text-slate-600 transition-colors">Info</span>
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
  <div class="relative w-full max-w-sm glass rounded-2xl p-5 space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold text-white">Add Coins</h3>
      <button onclick="closeModal('modal-buy-coins')" class="text-slate-500 hover:text-white">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
    <div id="coin-packages-list" class="space-y-2">
      <div class="shimmer h-16 rounded-xl"></div>
    </div>
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

<!-- Scripts -->
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
