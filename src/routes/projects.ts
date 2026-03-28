// DEPLOY Platform - Projects Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import { AIService } from '../services/ai.service';
import type { Bindings, Variables } from '../types';

const projects = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/projects
projects.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const page = parseInt(c.req.query('page') || '1');
  const perPage = 10;
  const offset = (page - 1) * perPage;

  const [items, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, 
              COUNT(DISTINCT bj.id) as build_count,
              COUNT(DISTINCT d.id) as deployment_count,
              (SELECT status FROM build_jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_build_status
       FROM projects p
       LEFT JOIN build_jobs bj ON bj.project_id = p.id
       LEFT JOIN deployments d ON d.project_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(user.id, perPage, offset).all(),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM projects WHERE user_id = ?').bind(user.id).first<{ total: number }>()
  ]);

  return c.json({
    success: true,
    data: {
      items: items.results,
      total: count?.total || 0,
      page, per_page: perPage,
      has_more: offset + perPage < (count?.total || 0)
    }
  });
});

// POST /api/projects
projects.post('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { name, description, category } = await c.req.json();

  if (!name?.trim()) {
    return c.json({ success: false, error: 'Project name is required' }, 400);
  }

  // Check plan limits
  const plan = await c.env.DB.prepare(
    `SELECT p.max_projects FROM plans p
     JOIN memberships m ON m.plan_id = p.id
     WHERE m.user_id = ?`
  ).bind(user.id).first<{ max_projects: number }>();

  const projectCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM projects WHERE user_id = ? AND status != 'archived'`
  ).bind(user.id).first<{ total: number }>();

  const maxProjects = plan?.max_projects || 3;
  if ((projectCount?.total || 0) >= maxProjects) {
    return c.json({ success: false, error: `Your plan allows up to ${maxProjects} active projects. Upgrade to create more.` }, 403);
  }

  const projectId = generateId('proj');
  const sessionId = generateId('sess');

  // Get default model for user's plan
  const defaultModel = await c.env.DB.prepare(
    `SELECT m.id FROM ai_models m
     JOIN ai_providers p ON p.id = m.provider_id
     WHERE m.is_active = 1
     ORDER BY m.sort_order ASC LIMIT 1`
  ).first<{ id: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO projects (id, user_id, name, description, category, status, active_model_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(projectId, user.id, name.trim(), description || null, category || null, 'draft', defaultModel?.id || null),

    c.env.DB.prepare(
      'INSERT INTO prompt_sessions (id, user_id, project_id, version, status, completeness_score, mode) VALUES (?, ?, ?, 1, ?, 0, ?)'
    ).bind(sessionId, user.id, projectId, 'draft', 'guided'),

    c.env.DB.prepare(
      'INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(generateId('log'), user.id, 'project_created', 'project', projectId)
  ]);

  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  return c.json({ success: true, data: { project, session_id: sessionId } }, 201);
});

// GET /api/projects/:id
projects.get('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const project = await c.env.DB.prepare(
    `SELECT p.*,
            ps.id as session_id, ps.completeness_score, ps.status as session_status, ps.mode,
            (SELECT COUNT(*) FROM build_jobs WHERE project_id = p.id) as build_count,
            (SELECT COUNT(*) FROM deployments WHERE project_id = p.id) as deployment_count,
            (SELECT status FROM build_jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_build_status,
            am.display_name as model_name
     FROM projects p
     LEFT JOIN prompt_sessions ps ON ps.project_id = p.id AND ps.status != 'submitted'
     LEFT JOIN ai_models am ON am.id = p.active_model_id
     WHERE p.id = ? AND p.user_id = ?`
  ).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ success: false, error: 'Project not found' }, 404);
  }

  return c.json({ success: true, data: project });
});

// PUT /api/projects/:id
projects.put('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');
  const { name, description, category, active_model_id } = await c.req.json();

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE projects SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       category = COALESCE(?, category),
       active_model_id = COALESCE(?, active_model_id),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(name || null, description || null, category || null, active_model_id || null, projectId).run();

  return c.json({ success: true, message: 'Project updated' });
});

// DELETE /api/projects/:id (archive)
projects.delete('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  await c.env.DB.prepare(
    `UPDATE projects SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`
  ).bind(projectId, user.id).run();

  return c.json({ success: true, message: 'Project archived' });
});

// GET /api/projects/:id/outputs
projects.get('/:id/outputs', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const outputs = await c.env.DB.prepare(
    `SELECT go.*, bj.status as job_status, bj.type as job_type
     FROM generated_outputs go
     JOIN build_jobs bj ON bj.id = go.job_id
     WHERE go.project_id = ? AND go.is_current = 1
     ORDER BY go.created_at DESC`
  ).bind(projectId).all();

  return c.json({ success: true, data: outputs.results });
});

// POST /api/projects/:id/build
projects.post('/:id/build', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');
  const { model_id, type = 'build', revision_notes } = await c.req.json();

  // Validate project ownership
  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; name: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Get active prompt session
  const session = await c.env.DB.prepare(
    `SELECT ps.*, json_group_object(pf.field_key, pf.value) as fields_json
     FROM prompt_sessions ps
     LEFT JOIN prompt_fields pf ON pf.session_id = ps.id
     WHERE ps.project_id = ? AND ps.status != 'submitted'
     GROUP BY ps.id
     ORDER BY ps.updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string; completeness_score: number; fields_json: string }>();

  if (!session) {
    return c.json({ success: false, error: 'No active prompt session found. Please complete your prompt first.' }, 400);
  }

  if (session.completeness_score < 40) {
    return c.json({ success: false, error: `Your prompt is only ${session.completeness_score}% complete. Please fill in more details before building.` }, 400);
  }

  const selectedModelId = model_id || project.active_model_id;
  if (!selectedModelId) {
    return c.json({ success: false, error: 'Please select an AI model first' }, 400);
  }

  // Get model cost
  const modelInfo = await c.env.DB.prepare(
    'SELECT * FROM ai_models WHERE id = ? AND is_active = 1'
  ).bind(selectedModelId).first<{ base_coin_cost: number; coin_cost_multiplier: number; min_plan_slug: string }>();

  if (!modelInfo) return c.json({ success: false, error: 'Selected model is unavailable' }, 400);

  const coinCost = Math.ceil(modelInfo.base_coin_cost * modelInfo.coin_cost_multiplier) * (type === 'revision' ? 1 : 3);

  // Check coin balance
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < coinCost) {
    return c.json({
      success: false,
      error: `Insufficient coins. This build costs ${coinCost} coins. You have ${wallet?.balance || 0} coins.`,
      data: { required_coins: coinCost, current_balance: wallet?.balance || 0 }
    }, 402);
  }

  const jobId = generateId('job');
  const coinService = new CoinService(c.env.DB);

  // Hold coins
  const holdId = await coinService.holdCoins(user.id, coinCost, jobId, type);

  // Create build job
  await c.env.DB.prepare(
    `INSERT INTO build_jobs (id, user_id, project_id, session_id, model_id, type, status, coins_held, coin_hold_id, prompt_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
  ).bind(
    jobId, user.id, projectId, session.id, selectedModelId, type,
    coinCost, holdId,
    JSON.stringify({ revision_notes: revision_notes || null, fields: session.fields_json })
  ).run();

  // Update project status
  await c.env.DB.prepare(
    `UPDATE projects SET status = 'building', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(projectId).run();

  // In a real system this would go into Cloudflare Queues
  // For MVP: process immediately
  void this_processBuildJob(c.env, jobId, user.id, projectId, session.id, selectedModelId, type, holdId, session.fields_json);

  return c.json({
    success: true,
    data: { job_id: jobId, coins_held: coinCost, status: 'queued' },
    message: `Build job queued! ${coinCost} coins reserved.`
  }, 202);
});

// Background build processor
async function this_processBuildJob(
  env: Bindings, jobId: string, userId: string, projectId: string,
  sessionId: string, modelId: string, type: string, holdId: string, fieldsJson: string
) {
  try {
    await env.DB.prepare(
      `UPDATE build_jobs SET status = 'processing', started_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(jobId).run();

    const aiService = new AIService(env, env.DB);
    let fields: Record<string, string> = {};
    try { fields = JSON.parse(fieldsJson || '{}'); } catch { /* ignore */ }

    const result = await aiService.processIntent({
      intent: type === 'revision' ? 'generate_revision' : 'generate_spec',
      userId,
      projectId,
      sessionId,
      modelId,
      context: { prompt_data: fields }
    });

    if (result.success && result.output) {
      // Store output in R2
      const outputId = generateId('out');
      const r2Key = `outputs/${userId}/${projectId}/${jobId}/spec.json`;

      try {
        await env.DEPLOY_R2.put(r2Key, result.output, {
          httpMetadata: { contentType: 'application/json' }
        });
      } catch { /* R2 might not be configured locally */ }

      const coinService = new CoinService(env.DB);
      await coinService.releaseHold(holdId, true);

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO generated_outputs (id, job_id, project_id, version, type, r2_key, file_name, content_type)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
        ).bind(outputId, jobId, projectId, type, r2Key, 'spec.json', 'application/json'),

        env.DB.prepare(
          `UPDATE build_jobs SET status = 'completed', result_summary = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(result.output.substring(0, 500), jobId),

        env.DB.prepare(
          `UPDATE projects SET status = 'built', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(projectId),

        env.DB.prepare(
          `INSERT INTO notifications (id, user_id, type, title, message, action_url)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(generateId('notif'), userId, 'build_complete', 'Build Complete!',
          'Your app spec has been generated. Review it now.', `/projects/${projectId}`)
      ]);

      // Store spec
      try {
        const specId = generateId('spec');
        const specData = result.structured || {};
        await env.DB.prepare(
          `INSERT INTO generated_specs (id, job_id, project_id, version, product_summary, readiness_score, r2_key)
           VALUES (?, ?, ?, 1, ?, ?, ?)`
        ).bind(
          specId, jobId, projectId,
          (specData as Record<string, string>).product_summary?.substring(0, 500) || 'App specification generated',
          (specData as Record<string, number>).readiness_score || 75, r2Key
        ).run();
      } catch { /* ignore spec parse errors */ }

    } else {
      const coinService = new CoinService(env.DB);
      await coinService.releaseHold(holdId, false); // Return coins on failure

      await env.DB.batch([
        env.DB.prepare(
          `UPDATE build_jobs SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(result.error || 'Build failed', jobId),
        env.DB.prepare(
          `UPDATE projects SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(projectId),
        env.DB.prepare(
          `INSERT INTO notifications (id, user_id, type, title, message)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(generateId('notif'), userId, 'build_failed', 'Build Failed',
          result.error || 'Your build encountered an error. Coins have been returned.')
      ]);
    }
  } catch (err) {
    console.error('Build job processing error:', err);
    const coinService = new CoinService(env.DB);
    await coinService.releaseHold(holdId, false);
    await env.DB.prepare(
      `UPDATE build_jobs SET status = 'failed', error_message = 'Internal error', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(jobId).run();
  }
}

// GET /api/projects/:id/jobs
projects.get('/:id/jobs', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const jobs = await c.env.DB.prepare(
    `SELECT bj.*, am.display_name as model_name
     FROM build_jobs bj
     LEFT JOIN ai_models am ON am.id = bj.model_id
     WHERE bj.project_id = ?
     ORDER BY bj.created_at DESC LIMIT 20`
  ).bind(projectId).all();

  return c.json({ success: true, data: jobs.results });
});

export default projects;
