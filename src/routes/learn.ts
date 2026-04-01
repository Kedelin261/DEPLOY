// DEPLOY Platform — Education & Info Hub Routes
// Serves onboarding progress, FAQ data, usage guides, and the
// interactive Education Hub HTML page at /learn.

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const learn = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── GET /api/learn/onboarding ─────────────────────────────────────────────────
// Returns the current user's onboarding progress.
learn.get('/onboarding', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  let progress = await c.env.DB.prepare(
    'SELECT * FROM onboarding_progress WHERE user_id = ?'
  ).bind(user.id).first<{
    id: string; completed_steps: string; current_step: string; completed_at: string | null;
  }>().catch(() => null);

  if (!progress) {
    // Bootstrap onboarding record
    await c.env.DB.prepare(
      `INSERT INTO onboarding_progress (id, user_id, completed_steps, current_step)
       VALUES (?, ?, '[]', 'welcome')`
    ).bind(generateId('onb'), user.id).run().catch(() => {});

    progress = { id: '', completed_steps: '[]', current_step: 'welcome', completed_at: null };
  }

  let completedSteps: string[] = [];
  try { completedSteps = JSON.parse(progress.completed_steps || '[]'); } catch { completedSteps = []; }

  const allSteps = getOnboardingSteps();
  const stepsWithStatus = allSteps.map(step => ({
    ...step,
    completed: completedSteps.includes(step.key),
    is_current: step.key === progress!.current_step,
  }));

  const totalSteps = allSteps.length;
  const doneCount = completedSteps.length;

  return c.json({
    success: true,
    data: {
      steps: stepsWithStatus,
      completed_count: doneCount,
      total_steps: totalSteps,
      percent: Math.round((doneCount / totalSteps) * 100),
      completed_at: progress.completed_at,
      is_complete: doneCount >= totalSteps,
    },
  });
});

// ── POST /api/learn/onboarding/complete ───────────────────────────────────────
// Marks an onboarding step as complete.
learn.post('/onboarding/complete', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { step_key } = await c.req.json();

  if (!step_key) return c.json({ success: false, error: 'step_key is required' }, 400);

  const validKeys = getOnboardingSteps().map(s => s.key);
  if (!validKeys.includes(step_key)) {
    return c.json({ success: false, error: 'Invalid step key' }, 400);
  }

  // Get or create progress record
  let progress = await c.env.DB.prepare(
    'SELECT * FROM onboarding_progress WHERE user_id = ?'
  ).bind(user.id).first<{ completed_steps: string; current_step: string }>().catch(() => null);

  let completedSteps: string[] = [];
  try { completedSteps = JSON.parse(progress?.completed_steps || '[]'); } catch { completedSteps = []; }

  if (!completedSteps.includes(step_key)) {
    completedSteps.push(step_key);
  }

  const allSteps = getOnboardingSteps();
  const nextStep = allSteps.find(s => !completedSteps.includes(s.key));
  const isAllDone = completedSteps.length >= allSteps.length;

  await c.env.DB.prepare(
    `INSERT INTO onboarding_progress (id, user_id, completed_steps, current_step, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       completed_steps = excluded.completed_steps,
       current_step = excluded.current_step,
       completed_at = excluded.completed_at,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(
    generateId('onb'), user.id,
    JSON.stringify(completedSteps),
    nextStep?.key || step_key,
    isAllDone ? new Date().toISOString() : null,
  ).run();

  return c.json({
    success: true,
    data: {
      completed_steps: completedSteps,
      next_step: nextStep?.key || null,
      is_complete: isAllDone,
      percent: Math.round((completedSteps.length / allSteps.length) * 100),
    },
    message: isAllDone ? 'Onboarding complete! 🎉' : `Step completed. Next: ${nextStep?.title || 'Done'}`,
  });
});

// ── GET /api/learn/faq ────────────────────────────────────────────────────────
learn.get('/faq', (c) => {
  return c.json({ success: true, data: FAQ_ITEMS });
});

// ── GET /api/learn/guides ─────────────────────────────────────────────────────
learn.get('/guides', (c) => {
  return c.json({ success: true, data: USAGE_GUIDES });
});

// ── GET /api/learn/coin-economy ───────────────────────────────────────────────
learn.get('/coin-economy', (c) => {
  return c.json({
    success: true,
    data: {
      overview: 'Coins are the credit unit powering all AI operations on DEPLOY. They are non-expiring, non-refundable, and fully transparent.',
      actions: COIN_ECONOMY,
      packages: [
        { coins: 100, price_usd: 4.99, label: 'Starter Pack' },
        { coins: 300, price_usd: 12.99, label: 'Builder Pack', badge: 'Popular' },
        { coins: 750, price_usd: 24.99, label: 'Pro Pack', badge: 'Best Value' },
        { coins: 2000, price_usd: 59.99, label: 'Team Pack' },
      ],
      plans: [
        { slug: 'free', monthly_coins: 50, max_projects: 2, model_access: 'fast', price: 0 },
        { slug: 'member', monthly_coins: 500, max_projects: 10, model_access: 'fast', price: 12 },
        { slug: 'pro', monthly_coins: 2000, max_projects: 30, model_access: 'reasoning', price: 39 },
        { slug: 'team', monthly_coins: 8000, max_projects: 100, model_access: 'all', price: 99 },
      ],
    },
  });
});

// ── GET /api/learn/glossary ───────────────────────────────────────────────────
learn.get('/glossary', (c) => {
  return c.json({ success: true, data: GLOSSARY });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC CONTENT DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

function getOnboardingSteps() {
  return [
    {
      key: 'welcome',
      title: 'Welcome to DEPLOY',
      description: 'Learn what DEPLOY does and how it turns your idea into a production-ready app.',
      icon: 'fa-rocket',
      estimate_minutes: 2,
    },
    {
      key: 'create_project',
      title: 'Create Your First Project',
      description: 'Give your app a name and pick a category. Takes 30 seconds.',
      icon: 'fa-plus-circle',
      estimate_minutes: 1,
    },
    {
      key: 'fill_prompt',
      title: 'Fill In the App Blueprint',
      description: 'Describe your app idea using the guided sections. The more detail, the better your build.',
      icon: 'fa-edit',
      estimate_minutes: 10,
    },
    {
      key: 'run_build',
      title: 'Run Your First Build',
      description: 'Submit the blueprint to the AI engine. Watch your app spec get generated in real-time.',
      icon: 'fa-hammer',
      estimate_minutes: 3,
    },
    {
      key: 'review_output',
      title: 'Review the Output',
      description: 'Explore the generated specification, architecture summary, and feature map.',
      icon: 'fa-file-alt',
      estimate_minutes: 5,
    },
    {
      key: 'top_up_coins',
      title: 'Top Up Your Coin Balance',
      description: 'Understand the coin economy and purchase your first coin pack.',
      icon: 'fa-coins',
      estimate_minutes: 2,
    },
    {
      key: 'deploy_project',
      title: 'Deploy to Cloudflare Pages',
      description: 'Convert your spec into a live deployment with a real URL.',
      icon: 'fa-globe',
      estimate_minutes: 2,
    },
  ];
}

const COIN_ECONOMY = [
  { action: 'AI Assist (single field)', cost: 2, type: 'ai_assist', description: 'AI fills in one prompt field for you' },
  { action: 'Build Request (fast model)', cost: 6, type: 'build', description: 'Full spec generation with fast AI model' },
  { action: 'Build Request (premium model)', cost: 15, type: 'build', description: 'Full spec generation with premium AI model' },
  { action: 'Build Request (reasoning model)', cost: 30, type: 'build', description: 'Deep reasoning spec with top-tier AI' },
  { action: 'Revision', cost: 10, type: 'revision', description: 'Apply a targeted change to an existing spec' },
  { action: 'Chat Message', cost: 2, type: 'chat', description: 'Ask the AI about your build' },
  { action: 'Build Summary', cost: 5, type: 'summary', description: 'Generate a plain-English summary of the build' },
  { action: 'Spec Transformation', cost: 4, type: 'transform', description: 'Break spec into feature map, screen map, data model, API contracts' },
  { action: 'Deployment', cost: 15, type: 'deployment', description: 'Deploy build to Cloudflare Pages with live URL' },
];

const FAQ_ITEMS = [
  {
    category: 'Getting Started',
    items: [
      {
        q: 'What is DEPLOY?',
        a: 'DEPLOY is an AI-powered app blueprint platform. You describe your app idea through a structured form, and the AI generates a complete specification: architecture, feature map, API contracts, data model, and deployment guide. You then deploy the output to Cloudflare Pages.',
      },
      {
        q: 'What do I get when I run a build?',
        a: 'You get a full product specification including: product summary, feature map, screen map, role permissions, data model, API contracts, architecture overview, folder structure, environment variables, CI/CD setup, and deployment plan.',
      },
      {
        q: 'Do I need to know how to code?',
        a: 'No. DEPLOY is designed for product thinkers, founders, and no-coders. The output is a detailed blueprint that any developer (or an AI coding assistant like Cursor) can implement. We recommend pasting the output into Cursor + Claude for fastest results.',
      },
    ],
  },
  {
    category: 'Coins & Billing',
    items: [
      {
        q: 'What are coins?',
        a: 'Coins are the credit unit that powers all AI operations. Each action (build, revision, chat, deploy) costs a fixed number of coins. Free accounts start with 50 coins. You can top up anytime from the Vault.',
      },
      {
        q: 'Do coins expire?',
        a: 'No. Purchased coins never expire. Monthly plan coins reset at the start of each billing period.',
      },
      {
        q: 'Can I get a refund?',
        a: 'Coins are non-refundable once used. Unused purchased coins can be refunded within 14 days of purchase — contact support.',
      },
      {
        q: 'What happens if a build fails?',
        a: 'If a build fails, your coins are automatically returned to your wallet. You are never charged for failed operations.',
      },
    ],
  },
  {
    category: 'AI Models',
    items: [
      {
        q: 'What AI models are available?',
        a: 'DEPLOY supports three tiers: Fast (GPT-4o Mini, Claude Haiku — low cost, great for most apps), Premium (GPT-4o, Claude Sonnet — more detail and nuance), and Reasoning (o1, Claude Opus — deep analysis for complex systems). Higher plans unlock higher-tier models.',
      },
      {
        q: 'Which model should I use?',
        a: 'Start with a Fast model for quick iterations. Upgrade to Premium when you want a more detailed spec. Use Reasoning for complex multi-role SaaS platforms or apps with intricate business logic.',
      },
    ],
  },
  {
    category: 'Deployment',
    items: [
      {
        q: 'Where does my app deploy?',
        a: 'DEPLOY deploys to Cloudflare Pages — a globally distributed, free-tier-eligible hosting platform. You get a live URL at <your-project>.pages.dev within seconds.',
      },
      {
        q: 'Can I use a custom domain?',
        a: 'Yes. After deploying to Cloudflare Pages, you can add a custom domain through the Cloudflare dashboard at zero extra cost.',
      },
      {
        q: 'What is included in the deployment?',
        a: 'The deployment packages the generated build output into a Cloudflare Pages project. The output includes the specification files, architecture summary, and a starter template so developers can immediately begin implementing.',
      },
    ],
  },
  {
    category: 'Privacy & Security',
    items: [
      {
        q: 'Is my app idea private?',
        a: 'Yes. Your project data is stored in your private D1 database partition. It is never shared with other users or used to train AI models.',
      },
      {
        q: 'Are my API keys safe?',
        a: 'DEPLOY never exposes secret API keys to the frontend. All AI calls go through the server-side Intent Layer. Keys are stored as Cloudflare secrets, never in code.',
      },
    ],
  },
];

const USAGE_GUIDES = [
  {
    id: 'getting-started',
    title: 'Getting Started Guide',
    icon: 'fa-play-circle',
    time_minutes: 15,
    sections: [
      {
        title: '1. Create a Project',
        content: 'Click "New Project" on the Home screen. Enter a project name (e.g., "TaskFlow SaaS") and select a category. Your project is created instantly.',
      },
      {
        title: '2. Fill the App Blueprint',
        content: 'The Prompt Builder has 7 sections: App Info, Features, Visual Design, Technical Stack, Business Model, Deployment, and Comments. Required sections are marked. Use AI Assist buttons (2 coins each) if you get stuck.',
      },
      {
        title: '3. Run a Build',
        content: 'When your blueprint is at least 40% complete, the Build button activates. Select your AI model and click "Build". The AI generates your complete app specification in 30–90 seconds.',
      },
      {
        title: '4. Review & Revise',
        content: 'Open the Test & Revise modal to chat with the AI about your build and request targeted revisions (10 coins each). Use the Specification Viewer to explore the full output.',
      },
      {
        title: '5. Deploy',
        content: 'Click "Publish" on any project. Confirm the 15-coin deployment cost. Your app is deployed to Cloudflare Pages and you receive a live URL.',
      },
    ],
  },
  {
    id: 'prompt-tips',
    title: 'Writing Great App Blueprints',
    icon: 'fa-lightbulb',
    time_minutes: 10,
    sections: [
      {
        title: 'Be Specific About Users',
        content: 'Instead of "people who need help", write "freelance designers aged 25–40 who manage 5–15 clients simultaneously". Specificity dramatically improves the AI output quality.',
      },
      {
        title: 'Define the Core Problem Precisely',
        content: 'Describe the exact pain point: "Users spend 3–4 hours per week manually tracking invoice status across email threads". The AI uses this to prioritize features.',
      },
      {
        title: 'List Features as User Goals',
        content: 'Instead of "dashboard", write "See all active projects and their payment status at a glance". User-goal framing produces better feature maps.',
      },
      {
        title: 'Use the Advanced Sections',
        content: 'The Technical, Business, and Deployment sections unlock powerful customization: choose your database (D1, Postgres), UI framework (Next.js, Remix), auth method, and monetization model.',
      },
    ],
  },
  {
    id: 'coin-guide',
    title: 'Coin Economy Guide',
    icon: 'fa-coins',
    time_minutes: 5,
    sections: [
      {
        title: 'How Coins Work',
        content: 'Every AI operation costs coins. Coins are debited at the time of the operation. If an operation fails, coins are automatically refunded. You can see a full ledger in the Vault.',
      },
      {
        title: 'Coin Holds',
        content: 'When you start a build, DEPLOY places a "hold" on your coins. The hold is released and coins are debited only when the build completes successfully. If the build fails, the hold is cancelled and coins are fully restored.',
      },
      {
        title: 'Getting More Coins',
        content: 'Go to Vault → Buy Coins. Choose a coin pack and pay securely via Stripe. Coins are credited to your account instantly upon payment confirmation.',
      },
    ],
  },
  {
    id: 'deployment-guide',
    title: 'Deploying to Cloudflare Pages',
    icon: 'fa-globe',
    time_minutes: 8,
    sections: [
      {
        title: 'What Gets Deployed',
        content: 'DEPLOY bundles your generated specification, architecture guide, and a starter code template into a Cloudflare Pages project. The live URL contains a downloadable version of your full app blueprint.',
      },
      {
        title: 'After Deployment',
        content: 'Take the generated blueprint and paste it into your preferred AI coding assistant (Cursor with Claude, GitHub Copilot, or ChatGPT). Say "implement this blueprint" and the AI will generate the actual code.',
      },
      {
        title: 'Rollback',
        content: 'Any deployment can be rolled back from the project\'s deployment history. Rollback does not cost coins.',
      },
    ],
  },
  {
    id: 'ai-tools-guide',
    title: 'Recommended AI Coding Assistants',
    icon: 'fa-robot',
    time_minutes: 5,
    sections: [
      {
        title: 'Cursor (Recommended)',
        content: 'Cursor is an AI-first code editor. Paste your DEPLOY blueprint into a new project, select all, and ask Claude/GPT to implement it. Best for Next.js, React, and TypeScript projects.',
        link: 'https://cursor.com',
      },
      {
        title: 'GitHub Copilot',
        content: 'Built into VS Code. Open your project folder, paste the architecture summary into a NOTES.md file, and use Copilot Chat to generate files one by one.',
        link: 'https://github.com/features/copilot',
      },
      {
        title: 'Bolt.new / Lovable',
        content: 'Web-based AI app builders. Paste your DEPLOY feature list and spec into the prompt. Works great for React + Tailwind frontends.',
        link: 'https://bolt.new',
      },
    ],
  },
];

const GLOSSARY = [
  { term: 'Blueprint', definition: 'The structured app description you fill in using the Prompt Builder. It defines your app\'s goals, features, tech stack, and business model.' },
  { term: 'Build', definition: 'An AI-powered generation run that converts your blueprint into a full product specification.' },
  { term: 'Build Job', definition: 'A queued or running build request. Each build job has a status (queued → processing → completed/failed) and a coin cost.' },
  { term: 'Spec', definition: 'The generated output of a build: product summary, feature map, screen map, data model, API contracts, architecture overview, folder structure, env vars, and deployment plan.' },
  { term: 'Spec Transformation', definition: 'A secondary AI pass that breaks the spec into structured machine-readable sections (feature_map, screen_map, data_model, api_contracts, etc.).' },
  { term: 'Coins', definition: 'The credit unit on DEPLOY. All AI operations cost coins. They are non-expiring and visible in your Vault.' },
  { term: 'Coin Hold', definition: 'Coins reserved before a build begins. Released and debited on success, or cancelled and restored on failure.' },
  { term: 'Vault', definition: 'Your financial control center: wallet balance, ledger history, coin analytics, billing, and payment methods.' },
  { term: 'Intent Layer', definition: 'The server-side routing layer that all AI requests pass through. Ensures keys stay server-side, logging happens, and rate limits are enforced.' },
  { term: 'Revision', definition: 'A targeted AI update to an existing spec. Describe the change and the AI applies it without regenerating the entire spec.' },
  { term: 'Deployment', definition: 'Publishing your build output to Cloudflare Pages, resulting in a live URL.' },
  { term: 'Readiness Score', definition: 'A 0–100 score reflecting how complete and implementable your blueprint + spec is. Higher is better. 80+ is production-ready.' },
  { term: 'AI Assist', definition: 'An AI fill-in for a single prompt field. Costs 2 coins. Useful when you\'re unsure what to write.' },
  { term: 'Model Tier', definition: 'Fast / Premium / Reasoning — three tiers of AI model, each with different cost and capability levels.' },
];

export default learn;
