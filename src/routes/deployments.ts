// DEPLOY Platform - Deployments Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/deployments
deployments.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  const result = await c.env.DB.prepare(
    `SELECT d.*, p.name as project_name
     FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE d.user_id = ?
     ORDER BY d.created_at DESC LIMIT 20`
  ).bind(user.id).all();

  return c.json({ success: true, data: result.results });
});

// POST /api/deployments - Request deployment
deployments.post('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { project_id, type = 'production', domain } = await c.req.json();

  if (!project_id) return c.json({ success: false, error: 'project_id required' }, 400);

  // Verify project and check it has outputs
  const project = await c.env.DB.prepare(
    `SELECT p.*, COUNT(go.id) as output_count
     FROM projects p
     LEFT JOIN generated_outputs go ON go.project_id = p.id AND go.is_current = 1
     WHERE p.id = ? AND p.user_id = ?
     GROUP BY p.id`
  ).bind(project_id, user.id).first<{ id: string; name: string; status: string; output_count: number }>();

  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);
  if (project.output_count === 0) {
    return c.json({ success: false, error: 'No generated outputs found. Please run a build first.' }, 400);
  }

  // Check deployment limits
  const plan = await c.env.DB.prepare(
    `SELECT p.max_deployments FROM plans p JOIN memberships m ON m.plan_id = p.id WHERE m.user_id = ?`
  ).bind(user.id).first<{ max_deployments: number }>();

  const deployCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM deployments WHERE user_id = ? AND status IN ('live', 'deploying')`
  ).bind(user.id).first<{ total: number }>();

  const maxDeploys = plan?.max_deployments || 1;
  if ((deployCount?.total || 0) >= maxDeploys) {
    return c.json({
      success: false,
      error: `Your plan allows ${maxDeploys} active deployments. Upgrade to deploy more.`
    }, 403);
  }

  // Check coin cost for deployment (15 coins)
  const DEPLOY_COST = 15;
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < DEPLOY_COST) {
    return c.json({
      success: false,
      error: `Deployment costs ${DEPLOY_COST} coins. You have ${wallet?.balance || 0} coins.`,
      data: { required_coins: DEPLOY_COST, current_balance: wallet?.balance || 0 }
    }, 402);
  }

  const deployId = generateId('dep');
  const cfProjectName = `deploy-${project.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${deployId.slice(-6)}`;

  await c.env.DB.prepare(
    `INSERT INTO deployments (id, user_id, project_id, version, type, status, platform, cloudflare_project_name, domain)
     VALUES (?, ?, ?, 1, ?, 'pending', 'cloudflare', ?, ?)`
  ).bind(deployId, user.id, project_id, type, cfProjectName, domain || null).run();

  // Debit coins
  await c.env.DB.prepare(
    `UPDATE coin_wallets SET balance = balance - ?, lifetime_spent = lifetime_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
  ).bind(DEPLOY_COST, DEPLOY_COST, user.id).run();
  await c.env.DB.prepare(
    `INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description, reference_id)
     SELECT ?, ?, w.id, 'spend', ?, w.balance, 'Deployment request', ?
     FROM coin_wallets w WHERE w.user_id = ?`
  ).bind(generateId('cle'), user.id, -DEPLOY_COST, deployId, user.id).run();

  // Simulate deployment (in production, triggers Cloudflare Worker + Pages API)
  void simulateDeployment(c.env, deployId, cfProjectName);

  return c.json({
    success: true,
    data: { deployment_id: deployId, status: 'pending', cloudflare_project: cfProjectName },
    message: 'Deployment initiated!'
  }, 202);
});

async function simulateDeployment(env: Bindings, deployId: string, cfProjectName: string) {
  // Simulate deployment process
  await new Promise(r => setTimeout(r, 2000));
  
  const deployUrl = `https://${cfProjectName}.pages.dev`;
  
  await env.DB.prepare(
    `UPDATE deployments SET status = 'live', deployment_url = ?, deployed_at = CURRENT_TIMESTAMP, 
     health_status = 'healthy', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(deployUrl, deployId).run();
}

// GET /api/deployments/:id
deployments.get('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const deployId = c.req.param('id');

  const deployment = await c.env.DB.prepare(
    `SELECT d.*, p.name as project_name FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE d.id = ? AND d.user_id = ?`
  ).bind(deployId, user.id).first();

  if (!deployment) return c.json({ success: false, error: 'Deployment not found' }, 404);

  return c.json({ success: true, data: deployment });
});

// POST /api/deployments/:id/rollback
deployments.post('/:id/rollback', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const deployId = c.req.param('id');

  await c.env.DB.prepare(
    `UPDATE deployments SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`
  ).bind(deployId, user.id).run();

  return c.json({ success: true, message: 'Deployment rolled back' });
});

export default deployments;
