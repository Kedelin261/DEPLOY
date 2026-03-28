// DEPLOY Platform - Prompt Session Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { AIService } from '../services/ai.service';
import type { Bindings, Variables } from '../types';

const prompt = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const PROMPT_SECTIONS = [
  { key: 'app_info', label: 'App Info', weight: 20, fields: ['app_name','category','audience','problem_statement'] },
  { key: 'features', label: 'Features', weight: 25, fields: ['core_features','ui_ux_notes','roles_permissions'] },
  { key: 'technical', label: 'Technical', weight: 20, fields: ['workflows','data_entities','apis_tools'] },
  { key: 'business', label: 'Business', weight: 20, fields: ['business_model','mvp_guardrails','future_versions'] },
  { key: 'deployment', label: 'Deployment', weight: 15, fields: ['deployment_preferences','platform_notes'] },
];

function calculateCompleteness(fields: Record<string, string>): number {
  let totalWeight = 0;
  let earnedWeight = 0;
  
  for (const section of PROMPT_SECTIONS) {
    const sectionWeight = section.weight;
    const fieldWeight = sectionWeight / section.fields.length;
    totalWeight += sectionWeight;
    
    for (const field of section.fields) {
      const value = fields[field];
      if (value && value.trim().length > 5) {
        earnedWeight += fieldWeight;
      }
    }
  }
  
  return Math.round((earnedWeight / totalWeight) * 100);
}

// GET /api/prompt/:project_id
prompt.get('/:project_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string; completeness_score: number; mode: string }>();

  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fieldsResult = await c.env.DB.prepare(
    'SELECT * FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all();

  // Build fields map
  const fieldsMap: Record<string, string> = {};
  for (const f of fieldsResult.results as Array<{ section_key: string; field_key: string; value: string }>) {
    fieldsMap[f.field_key] = f.value || '';
  }

  return c.json({
    success: true,
    data: {
      session,
      fields: fieldsMap,
      sections: PROMPT_SECTIONS,
      completeness_score: session.completeness_score
    }
  });
});

// PUT /api/prompt/:project_id/field
prompt.put('/:project_id/field', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { section_key, field_key, value } = await c.req.json();

  if (!section_key || !field_key) {
    return c.json({ success: false, error: 'section_key and field_key required' }, 400);
  }

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fieldId = generateId('pf');
  const isComplete = value && value.trim().length > 5 ? 1 : 0;

  // Upsert field
  await c.env.DB.prepare(
    `INSERT INTO prompt_fields (id, session_id, section_key, field_key, value, is_complete)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, field_key) DO UPDATE SET
       value = excluded.value,
       is_complete = excluded.is_complete,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(fieldId, session.id, section_key, field_key, value || '', isComplete).run();

  // Recalculate completeness
  const allFields = await c.env.DB.prepare(
    'SELECT field_key, value FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all<{ field_key: string; value: string }>();

  const fieldsMap: Record<string, string> = {};
  for (const f of allFields.results) {
    fieldsMap[f.field_key] = f.value || '';
  }
  const score = calculateCompleteness(fieldsMap);

  await c.env.DB.prepare(
    `UPDATE prompt_sessions SET completeness_score = ?, last_section = ?, autosave_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(score, section_key, session.id).run();

  // Update project readiness
  await c.env.DB.prepare(
    'UPDATE projects SET readiness_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, projectId).run();

  return c.json({ success: true, data: { completeness_score: score, field_saved: true } });
});

// PUT /api/prompt/:project_id/bulk
prompt.put('/:project_id/bulk', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { fields } = await c.req.json<{ fields: Record<string, { section_key: string; value: string }> }>();

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const statements = [];
  const fieldsMap: Record<string, string> = {};

  for (const [field_key, { section_key, value }] of Object.entries(fields)) {
    const isComplete = value && value.trim().length > 5 ? 1 : 0;
    fieldsMap[field_key] = value || '';
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO prompt_fields (id, session_id, section_key, field_key, value, is_complete)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, field_key) DO UPDATE SET
           value = excluded.value, is_complete = excluded.is_complete, updated_at = CURRENT_TIMESTAMP`
      ).bind(generateId('pf'), session.id, section_key, field_key, value || '', isComplete)
    );
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  const score = calculateCompleteness(fieldsMap);
  await c.env.DB.prepare(
    'UPDATE prompt_sessions SET completeness_score = ?, autosave_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, session.id).run();
  await c.env.DB.prepare(
    'UPDATE projects SET readiness_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(score, projectId).run();

  return c.json({ success: true, data: { completeness_score: score, saved_count: statements.length } });
});

// POST /api/prompt/:project_id/ai-assist
prompt.post('/:project_id/ai-assist', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');
  const { section_key, field_key, model_id } = await c.req.json();

  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? AND status != 'submitted' LIMIT 1`
  ).bind(projectId).first<{ id: string }>();
  if (!session) return c.json({ success: false, error: 'No active session' }, 404);

  const fields = await c.env.DB.prepare(
    'SELECT field_key, value FROM prompt_fields WHERE session_id = ?'
  ).bind(session.id).all<{ field_key: string; value: string }>();

  const fieldsMap: Record<string, string> = {};
  for (const f of fields.results) fieldsMap[f.field_key] = f.value || '';

  // Check coin cost - AI assist costs 2 coins (cheapest intent)
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < 2) {
    return c.json({ success: false, error: 'Insufficient coins. AI assist costs 2 coins.' }, 402);
  }

  const aiService = new AIService(c.env, c.env.DB);
  const selectedModel = model_id || project.active_model_id || 'model_gpt4o_mini';

  const result = await aiService.processIntent({
    intent: 'complete_prompt_field',
    userId: user.id,
    projectId,
    sessionId: session.id,
    modelId: selectedModel,
    context: {
      field_key,
      section_key,
      current_value: fieldsMap[field_key] || '',
      app_name: fieldsMap['app_name'] || '',
      category: fieldsMap['category'] || '',
      audience: fieldsMap['audience'] || '',
      problem: fieldsMap['problem_statement'] || ''
    }
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 500);
  }

  // Debit coins
  const { CoinService: CS } = await import('../services/coin.service');
  const cs = new CS(c.env.DB);
  await cs.debit(user.id, 2, 'spend', `AI assist: ${field_key}`, projectId, 'ai_assist');

  return c.json({
    success: true,
    data: {
      suggestion: result.output,
      coins_spent: 2
    }
  });
});

// GET /api/prompt/:project_id/export
prompt.get('/:project_id/export', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first<{ id: string; name: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const session = await c.env.DB.prepare(
    `SELECT * FROM prompt_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string; completeness_score: number }>();

  if (!session) return c.json({ success: false, error: 'No session found' }, 404);

  const fields = await c.env.DB.prepare(
    'SELECT section_key, field_key, value FROM prompt_fields WHERE session_id = ? AND value IS NOT NULL AND value != ?'
  ).bind(session.id, '').all<{ section_key: string; field_key: string; value: string }>();

  // Build the full prompt text
  const sectionData: Record<string, Record<string, string>> = {};
  for (const f of fields.results) {
    if (!sectionData[f.section_key]) sectionData[f.section_key] = {};
    sectionData[f.section_key][f.field_key] = f.value;
  }

  let promptText = `# DEPLOY App Blueprint — ${project.name}\n\n`;
  promptText += `Completeness Score: ${session.completeness_score}%\n\n`;
  promptText += `---\n\n`;

  for (const section of PROMPT_SECTIONS) {
    const data = sectionData[section.key];
    if (!data || Object.keys(data).length === 0) continue;
    promptText += `## ${section.label}\n\n`;
    for (const [key, value] of Object.entries(data)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      promptText += `**${label}:**\n${value}\n\n`;
    }
  }

  return c.json({
    success: true,
    data: {
      prompt_text: promptText,
      completeness_score: session.completeness_score,
      project_name: project.name
    }
  });
});

export default prompt;
