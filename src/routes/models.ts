// DEPLOY Platform - Model Switcher Routes

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const models = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/models - Get all models with user access info
models.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;

  // Plan hierarchy for access check
  const planOrder: Record<string, number> = { free: 0, member: 1, pro: 2, team: 3 };
  const userPlanLevel = planOrder[user.plan_slug] ?? 0;

  const result = await c.env.DB.prepare(
    `SELECT m.*, p.name as provider_name, p.slug as provider_slug
     FROM ai_models m
     JOIN ai_providers p ON p.id = m.provider_id
     WHERE m.is_active = 1
     ORDER BY m.sort_order ASC`
  ).all<{
    id: string; name: string; model_id: string; display_name: string;
    description: string; capability_tags: string; coin_cost_multiplier: number;
    base_coin_cost: number; min_plan_slug: string; sort_order: number;
    provider_name: string; provider_slug: string;
  }>();

  const models = result.results.map(m => {
    const requiredLevel = planOrder[m.min_plan_slug] ?? 0;
    const accessible = userPlanLevel >= requiredLevel;
    let tags: string[] = [];
    try { tags = JSON.parse(m.capability_tags); } catch { tags = []; }

    return {
      ...m,
      capability_tags: tags,
      accessible,
      locked_reason: accessible ? null : `Requires ${m.min_plan_slug} plan or higher`,
      estimated_cost_per_build: Math.ceil(m.base_coin_cost * m.coin_cost_multiplier) * 3
    };
  });

  return c.json({ success: true, data: models });
});

// PUT /api/models/select - Set active model for project
models.put('/select', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const { project_id, model_id } = await c.req.json();

  if (!project_id || !model_id) {
    return c.json({ success: false, error: 'project_id and model_id required' }, 400);
  }

  // Verify model access
  const planOrder: Record<string, number> = { free: 0, member: 1, pro: 2, team: 3 };
  const userPlanLevel = planOrder[user.plan_slug] ?? 0;

  const model = await c.env.DB.prepare(
    'SELECT * FROM ai_models WHERE id = ? AND is_active = 1'
  ).bind(model_id).first<{ min_plan_slug: string; display_name: string }>();

  if (!model) return c.json({ success: false, error: 'Model not found' }, 404);

  const requiredLevel = planOrder[model.min_plan_slug] ?? 0;
  if (userPlanLevel < requiredLevel) {
    return c.json({
      success: false,
      error: `${model.display_name} requires ${model.min_plan_slug} plan. Upgrade to access this model.`
    }, 403);
  }

  // Verify project ownership
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?'
  ).bind(project_id, user.id).first();

  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  await c.env.DB.prepare(
    'UPDATE projects SET active_model_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(model_id, project_id).run();

  return c.json({
    success: true,
    message: `Model switched to ${model.display_name}`,
    data: { model_id, model_name: model.display_name }
  });
});

export default models;
