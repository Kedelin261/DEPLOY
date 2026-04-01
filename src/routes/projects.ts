// DEPLOY Platform - Projects Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import { CoinService } from '../services/coin.service';
import { AIService } from '../services/ai.service';
import { rateLimitMiddleware } from '../middleware/rateLimit';
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
              (SELECT status FROM build_jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_build_status,
              COALESCE(
                NULLIF(p.readiness_score, 0),
                (SELECT ps.completeness_score FROM prompt_sessions ps WHERE ps.project_id = p.id ORDER BY ps.updated_at DESC LIMIT 1),
                0
              ) as readiness_score
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
            am.display_name as model_name,
            COALESCE(NULLIF(p.readiness_score, 0), ps.completeness_score, 0) as readiness_score
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

// GET /api/projects/:id/spec  — fetch latest spec JSON from R2
projects.get('/:id/spec', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Find the latest output for this project
  const output = await c.env.DB.prepare(
    `SELECT go.r2_key FROM generated_outputs go
     WHERE go.project_id = ? AND go.is_current = 1
     ORDER BY go.created_at DESC LIMIT 1`
  ).bind(projectId).first<{ r2_key: string }>();

  if (!output) return c.json({ success: true, spec: null });

  // Fetch from R2
  try {
    const obj = await c.env.DEPLOY_R2.get(output.r2_key);
    if (!obj) return c.json({ success: true, spec: null });
    const text = await obj.text();
    let spec = null;
    try { spec = JSON.parse(text); } catch (_) { spec = { raw: text }; }
    return c.json({ success: true, spec });
  } catch (err) {
    console.error('R2 fetch error', err);
    return c.json({ success: true, spec: null });
  }
});

// GET /api/projects/:id/preview  — all data needed to render the interactive app preview
projects.get('/:id/preview', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  // Fetch project + session + fields + latest build result in parallel
  const [projectRow, fieldsRow, buildRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, ps.completeness_score,
              COALESCE(NULLIF(p.readiness_score,0), ps.completeness_score, 0) as readiness_score,
              (SELECT COUNT(*) FROM build_jobs WHERE project_id = p.id) as build_count
       FROM projects p
       LEFT JOIN prompt_sessions ps ON ps.project_id = p.id AND ps.status != 'submitted'
       WHERE p.id = ? AND p.user_id = ?`
    ).bind(projectId, user.id).first<Record<string, unknown>>(),

    c.env.DB.prepare(
      `SELECT pf.field_key, pf.value
       FROM prompt_fields pf
       JOIN prompt_sessions ps ON ps.id = pf.session_id
       WHERE ps.project_id = ? AND ps.status != 'submitted'`
    ).bind(projectId).all<{ field_key: string; value: string }>(),

    c.env.DB.prepare(
      `SELECT bj.result_summary, bj.completed_at, go.r2_key
       FROM build_jobs bj
       LEFT JOIN generated_outputs go ON go.job_id = bj.id AND go.is_current = 1
       WHERE bj.project_id = ? AND bj.status = 'completed'
       ORDER BY bj.completed_at DESC LIMIT 1`
    ).bind(projectId).first<{ result_summary: string; completed_at: string; r2_key: string }>(),
  ]);

  if (!projectRow) return c.json({ success: false, error: 'Project not found' }, 404);

  // Build fields map
  const fields: Record<string, string> = {};
  for (const f of (fieldsRow.results || [])) fields[f.field_key] = f.value;

  // Try to parse the build result summary as JSON
  let specJson: Record<string, unknown> | null = null;
  if (buildRow?.result_summary) {
    try { specJson = JSON.parse(buildRow.result_summary); } catch (_) {}
  }

  // Optionally fetch full spec from R2
  let fullSpec: Record<string, unknown> | null = null;
  if (buildRow?.r2_key) {
    try {
      const obj = await c.env.DEPLOY_R2.get(buildRow.r2_key);
      if (obj) {
        const txt = await obj.text();
        try { fullSpec = JSON.parse(txt); } catch (_) {}
      }
    } catch (_) {}
  }

  const merged = fullSpec || specJson;

  return c.json({
    success: true,
    data: {
      project: projectRow,
      fields,
      spec: merged,
      built_at: buildRow?.completed_at || null,
    }
  });
});

// POST /api/projects/:id/build
projects.post('/:id/build', authMiddleware(), rateLimitMiddleware('build_request'), async (c) => {
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

  // Process build synchronously within the request lifecycle.
  // Cloudflare Workers kills void background tasks after the response is sent,
  // so we MUST await the AI call before returning to the client.
  // The frontend polls /jobs for status updates while showing the preview.
  try {
    await this_processBuildJob(c.env, jobId, user.id, projectId, session.id, selectedModelId, type, holdId, session.fields_json);
  } catch (bgErr) {
    console.error('Build processor error:', bgErr);
    // Already handled inside this_processBuildJob — just log here
  }

  // Re-read final job status to return accurate info
  const finalJob = await c.env.DB.prepare(
    'SELECT status, error_message FROM build_jobs WHERE id = ?'
  ).bind(jobId).first<{ status: string; error_message: string }>();

  if (finalJob?.status === 'failed') {
    return c.json({
      success: false,
      error: finalJob.error_message || 'Build failed. Coins returned.',
      data: { job_id: jobId }
    }, 500);
  }

  return c.json({
    success: true,
    data: { job_id: jobId, coins_held: coinCost, status: finalJob?.status || 'completed' },
    message: `Build complete! ${coinCost} coins used.`
  }, 200);
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

    const context = type === 'revision'
      ? {
          revision_notes: fields.revision_notes || 'General improvements',
          build_summary: fields.build_summary || 'App specification',
          prompt_data: fields
        }
      : { prompt_data: fields };

    const result = await aiService.processIntent({
      intent: type === 'revision' ? 'generate_revision' : 'generate_spec',
      userId,
      projectId,
      sessionId,
      modelId,
      context
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
          `UPDATE projects SET status = 'built', readiness_score = COALESCE(NULLIF(readiness_score,0), (SELECT completeness_score FROM prompt_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1), 75), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(projectId, projectId),

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
        ).bind('Build failed. Coins have been returned.', jobId),
        env.DB.prepare(
          `UPDATE projects SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(projectId),
        env.DB.prepare(
          `INSERT INTO notifications (id, user_id, type, title, message)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(generateId('notif'), userId, 'build_failed', 'Build Failed',
          'Your build encountered an issue. Your coins have been returned — please try again.')
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

// GET /api/projects/:id/build-stream - SSE stream for real-time build progress
projects.get('/:id/build-stream', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');
  const jobId = c.req.query('job_id');

  const project = await c.env.DB.prepare('SELECT id, name, status FROM projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first<{ id: string; name: string; status: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Return SSE stream
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(msg));
      };

      // Poll for job status updates
      const maxPolls = 60; // 60 seconds max
      let polls = 0;
      
      send('connected', { project_id: projectId, job_id: jobId });

      const poll = async () => {
        try {
          let query = `SELECT bj.*, am.display_name as model_name 
                       FROM build_jobs bj 
                       LEFT JOIN ai_models am ON am.id = bj.model_id
                       WHERE bj.project_id = ?`;
          const params: (string | null)[] = [projectId];
          
          if (jobId) {
            query += ' AND bj.id = ?';
            params.push(jobId);
          }
          query += ' ORDER BY bj.created_at DESC LIMIT 1';
          
          const job = await c.env.DB.prepare(query).bind(...params).first<{
            id: string; status: string; type: string; model_name: string;
            error_message: string; result_summary: string;
            started_at: string; completed_at: string;
          }>();

          if (job) {
            send('progress', {
              job_id: job.id,
              status: job.status,
              type: job.type,
              model: job.model_name,
              message: getStatusMessage(job.status, job.type, polls),
              step: getProgressStep(job.status, polls),
              total_steps: 8
            });

            if (job.status === 'completed') {
              // Get the output
              const output = await c.env.DB.prepare(
                'SELECT * FROM generated_outputs WHERE job_id = ? AND is_current = 1 LIMIT 1'
              ).bind(job.id).first<{ id: string; r2_key: string }>();
              
              // Get spec if available
              const spec = await c.env.DB.prepare(
                'SELECT product_summary, readiness_score FROM generated_specs WHERE job_id = ? LIMIT 1'
              ).bind(job.id).first<{ product_summary: string; readiness_score: number }>();

              send('complete', {
                job_id: job.id,
                output_id: output?.id,
                product_summary: spec?.product_summary || job.result_summary,
                readiness_score: spec?.readiness_score || 75,
                message: 'Build complete! Your app spec is ready.'
              });
              controller.close();
              return;
            }

            if (job.status === 'failed') {
              send('error', {
                job_id: job.id,
                message: job.error_message || 'Build failed. Coins returned.'
              });
              controller.close();
              return;
            }
          } else {
            send('progress', {
              status: 'queued',
              message: 'Waiting for build to start...',
              step: 1,
              total_steps: 8
            });
          }

          polls++;
          if (polls < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            await poll();
          } else {
            send('timeout', { message: 'Build is taking longer than expected. Check back shortly.' });
            controller.close();
          }
        } catch (err) {
          console.error('SSE poll error:', err);
          send('error', { message: 'Stream error. Please refresh.' });
          controller.close();
        }
      };

      await poll();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  });
});

function getStatusMessage(status: string, type: string, poll: number): string {
  if (status === 'queued') return 'Initializing AI engine...';
  if (status === 'processing') {
    const steps = [
      'Analyzing your app requirements...',
      'Mapping feature architecture...',
      'Designing data models and schemas...',
      'Planning API contracts and endpoints...',
      'Generating UI/UX specifications...',
      'Creating deployment configuration...',
      'Finalizing security & performance plans...',
      'Assembling complete build specification...',
      'Running quality checks...',
      'Almost done! Packaging your build...',
    ];
    return steps[Math.min(poll, steps.length - 1)];
  }
  return 'Processing...';
}

function getProgressStep(status: string, poll: number): number {
  if (status === 'queued') return 1;
  if (status === 'processing') return Math.min(2 + Math.floor(poll * 0.5), 7);
  if (status === 'completed') return 8;
  return 1;
}

// POST /api/projects/:id/summarize - Generate build summary
projects.post('/:id/summarize', authMiddleware(), rateLimitMiddleware('summarize'), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; name: string; category: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Check coins (5 coins for summary)
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < 5) {
    return c.json({ success: false, error: 'Insufficient coins. Summary costs 5 coins.' }, 402);
  }

  // Get latest build output
  const latestSpec = await c.env.DB.prepare(
    `SELECT gs.product_summary, bj.result_summary 
     FROM generated_specs gs
     JOIN build_jobs bj ON bj.id = gs.job_id
     WHERE gs.project_id = ? 
     ORDER BY gs.created_at DESC LIMIT 1`
  ).bind(projectId).first<{ product_summary: string; result_summary: string }>();

  const modelId = project.active_model_id || 'model_gpt4o_mini';
  const aiService = new AIService(c.env, c.env.DB);
  
  const result = await aiService.processIntent({
    intent: 'summarize_build',
    userId: user.id,
    projectId,
    modelId,
    context: {
      app_name: project.name,
      category: project.category,
      build_output: latestSpec?.product_summary || latestSpec?.result_summary || 'App specification generated successfully',
    }
  });

  if (!result.success) {
    return c.json({ success: false, error: 'Unable to generate summary right now. Please try again.' }, 500);
  }

  // Debit coins
  const coinService = new CoinService(c.env.DB);
  await coinService.debit(user.id, 5, 'spend', 'Build summary generation', projectId, 'project');

  return c.json({ success: true, data: { summary: result.output, coins_spent: 5 } });
});

// POST /api/projects/:id/chat - AI chat about the build
projects.post('/:id/chat', authMiddleware(), rateLimitMiddleware('chat'), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');
  const { message, history } = await c.req.json();

  if (!message) return c.json({ success: false, error: 'Message is required' }, 400);

  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; name: string; category: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Check coins (2 coins per message)
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < 2) {
    return c.json({ success: false, error: 'Insufficient coins. Chat costs 2 coins per message.' }, 402);
  }

  const latestSpec = await c.env.DB.prepare(
    'SELECT product_summary FROM generated_specs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(projectId).first<{ product_summary: string }>();

  const modelId = project.active_model_id || 'model_gpt4o_mini';
  const aiService = new AIService(c.env, c.env.DB);

  const result = await aiService.processIntent({
    intent: 'chat',
    userId: user.id,
    projectId,
    modelId,
    context: {
      app_name: project.name,
      category: project.category,
      build_summary: latestSpec?.product_summary || 'App specification generated',
      message,
      history: history ? JSON.stringify(history).substring(0, 2000) : '[]'
    }
  });

  if (!result.success) {
    return c.json({ success: false, error: 'AI chat is temporarily unavailable. Please try again.' }, 500);
  }

  // Debit coins
  const coinService = new CoinService(c.env.DB);
  await coinService.debit(user.id, 2, 'spend', 'AI chat message', projectId, 'project');

  return c.json({ success: true, data: { reply: result.output, coins_spent: 2 } });
});

// POST /api/projects/:id/revise - Submit a revision
projects.post('/:id/revise', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');
  const { revision_notes, model_id } = await c.req.json();

  if (!revision_notes) return c.json({ success: false, error: 'Revision notes are required' }, 400);

  const project = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first<{ id: string; name: string; active_model_id: string }>();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const selectedModelId = model_id || project.active_model_id || 'model_gpt4o_mini';

  // Get model cost
  const modelInfo = await c.env.DB.prepare(
    'SELECT * FROM ai_models WHERE id = ? AND is_active = 1'
  ).bind(selectedModelId).first<{ base_coin_cost: number; coin_cost_multiplier: number }>();

  const coinCost = modelInfo ? Math.ceil(modelInfo.base_coin_cost * modelInfo.coin_cost_multiplier) : 10;

  // Check coins
  const wallet = await c.env.DB.prepare('SELECT balance FROM coin_wallets WHERE user_id = ?').bind(user.id).first<{ balance: number }>();
  if (!wallet || wallet.balance < coinCost) {
    return c.json({
      success: false,
      error: `Insufficient coins. Revision costs ${coinCost} coins. You have ${wallet?.balance || 0}.`,
      data: { required_coins: coinCost, current_balance: wallet?.balance || 0 }
    }, 402);
  }

  // Get session
  const session = await c.env.DB.prepare(
    `SELECT id FROM prompt_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();

  const jobId = generateId('job');
  const coinService = new CoinService(c.env.DB);
  const holdId = await coinService.holdCoins(user.id, coinCost, jobId, 'revision');

  await c.env.DB.prepare(
    `INSERT INTO build_jobs (id, user_id, project_id, session_id, model_id, type, status, coins_held, coin_hold_id, prompt_snapshot)
     VALUES (?, ?, ?, ?, ?, 'revision', 'queued', ?, ?, ?)`
  ).bind(
    jobId, user.id, projectId, session?.id || null, selectedModelId,
    coinCost, holdId, JSON.stringify({ revision_notes })
  ).run();

  await c.env.DB.prepare(
    `UPDATE projects SET status = 'building', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(projectId).run();

  // Get latest spec for context
  const latestSpec = await c.env.DB.prepare(
    'SELECT product_summary FROM generated_specs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(projectId).first<{ product_summary: string }>();

  // Process revision synchronously (same reason as build — background tasks get killed)
  try {
    await this_processBuildJob(
      c.env, jobId, user.id, projectId,
      session?.id || 'none', selectedModelId, 'revision', holdId,
      JSON.stringify({ revision_notes, build_summary: latestSpec?.product_summary || '' })
    );
  } catch (err) {
    console.error('Revision processor error:', err);
  }

  const finalJob = await c.env.DB.prepare(
    'SELECT status, error_message FROM build_jobs WHERE id = ?'
  ).bind(jobId).first<{ status: string; error_message: string }>();

  if (finalJob?.status === 'failed') {
    return c.json({
      success: false,
      error: finalJob.error_message || 'Revision failed. Coins returned.',
      data: { job_id: jobId }
    }, 500);
  }

  return c.json({
    success: true,
    data: { job_id: jobId, coins_held: coinCost, status: 'completed' },
    message: `Revision applied! ${coinCost} coins used.`
  }, 200);
});

// ── POST /api/projects/:id/transform ──────────────────────────────────────────
// Build Specification Transformer — Phase 2 feature.
// Reads the latest generated spec from R2/DB, calls the AI with intent
// 'generate_spec', and saves a structured spec_breakdown row to D1.
// Returns feature_map, screen_map, data_model, api_contracts, arch_summary,
// deployment_reqs, env_vars, risk_flags, and readiness_score.
// Cost: same as a build (uses the project's active model).
projects.post('/:id/transform', authMiddleware(), rateLimitMiddleware('build_request'), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  // Validate project ownership
  const project = await c.env.DB.prepare(
    `SELECT p.*, m.display_name AS model_name, m.model_id AS model_slug,
            m.base_coin_cost, m.coin_cost_multiplier
     FROM projects p
     LEFT JOIN ai_models m ON m.id = p.active_model_id
     WHERE p.id = ? AND p.user_id = ?`
  ).bind(projectId, user.id).first<{
    id: string; name: string; status: string; active_model_id: string;
    model_slug: string; base_coin_cost: number; coin_cost_multiplier: number;
  }>();

  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Must have a completed build with generated spec
  const latestJob = await c.env.DB.prepare(
    `SELECT j.id AS job_id, s.id AS spec_id, s.product_summary, s.spec_json_key
     FROM build_jobs j
     LEFT JOIN generated_specs s ON s.job_id = j.id
     WHERE j.project_id = ? AND j.status = 'completed'
     ORDER BY j.completed_at DESC LIMIT 1`
  ).bind(projectId).first<{
    job_id: string; spec_id: string; product_summary: string; spec_json_key: string;
  }>();

  if (!latestJob) {
    return c.json({ success: false, error: 'No completed build found. Run a build first.' }, 400);
  }

  // Calculate coin cost
  const baseCost = project.base_coin_cost ?? 2;
  const multiplier = project.coin_cost_multiplier ?? 1;
  const coinCost = Math.ceil(baseCost * multiplier);

  const coinService = new CoinService(c.env.DB);
  const wallet = await c.env.DB.prepare(
    'SELECT balance FROM coin_wallets WHERE user_id = ?'
  ).bind(user.id).first<{ balance: number }>();

  if ((wallet?.balance ?? 0) < coinCost) {
    return c.json({
      success: false,
      error: `Insufficient coins. Spec transformation costs ${coinCost} coins. Your balance: ${wallet?.balance ?? 0}.`,
      data: { required: coinCost, balance: wallet?.balance ?? 0 }
    }, 402);
  }

  // Fetch the spec content from R2 or DB summary
  let specContent = latestJob.product_summary || '';
  if (latestJob.spec_json_key && c.env.DEPLOY_R2) {
    try {
      const r2Obj = await c.env.DEPLOY_R2.get(latestJob.spec_json_key);
      if (r2Obj) {
        const raw = await r2Obj.text();
        specContent = raw.slice(0, 8000); // Limit context window
      }
    } catch { /* use DB summary as fallback */ }
  }

  // Fetch prompt fields for richer context
  const session = await c.env.DB.prepare(
    `SELECT ps.id FROM prompt_sessions ps WHERE ps.project_id = ? ORDER BY ps.updated_at DESC LIMIT 1`
  ).bind(projectId).first<{ id: string }>();

  let promptFields: Record<string, string> = {};
  if (session?.id) {
    const fields = await c.env.DB.prepare(
      'SELECT field_key, field_value FROM prompt_fields WHERE session_id = ?'
    ).bind(session.id).all<{ field_key: string; field_value: string }>();
    for (const f of fields.results) {
      promptFields[f.field_key] = f.field_value;
    }
  }

  // Call AI
  const aiService = new AIService(c.env, c.env.DB);
  const aiResult = await aiService.processIntent({
    intent: 'generate_spec',
    userId: user.id,
    projectId,
    sessionId: session?.id,
    modelId: project.active_model_id,
    context: {
      app_name: promptFields.app_name || project.name,
      existing_spec_summary: specContent,
      prompt_fields: promptFields,
      transform_request: 'Generate a complete structured breakdown with feature_map, screen_map, data_model, api_contracts, arch_summary, deployment_reqs, env_vars, risk_flags, and readiness_score.',
    },
  });

  if (!aiResult.success) {
    return c.json({ success: false, error: aiResult.error || 'Transformation failed.' }, 500);
  }

  // Debit coins
  await coinService.debit(user.id, coinCost, 'spend', `Spec transformation: ${project.name}`, projectId, 'transform');

  // Parse structured output
  let structured = aiResult.structured || {};
  if (!structured.feature_map && aiResult.output) {
    try { structured = JSON.parse(aiResult.output); } catch { /* partial parse ok */ }
  }

  const breakdownId = generateId('sb');

  // Save to spec_breakdowns
  await c.env.DB.prepare(
    `INSERT INTO spec_breakdowns
       (id, job_id, project_id, user_id, feature_map, screen_map, data_model,
        api_contracts, arch_summary, deployment_reqs, env_vars, risk_flags, readiness_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    breakdownId,
    latestJob.job_id,
    projectId,
    user.id,
    JSON.stringify(structured.feature_map ?? []),
    JSON.stringify(structured.screen_map ?? []),
    JSON.stringify(structured.data_model ?? []),
    JSON.stringify(structured.api_contracts ?? []),
    structured.arch_summary as string ?? aiResult.output?.slice(0, 2000) ?? '',
    JSON.stringify(structured.deployment_reqs ?? []),
    JSON.stringify(structured.env_vars ?? []),
    JSON.stringify(structured.risk_flags ?? []),
    (structured.readiness_score as number) ?? 75,
  ).run();

  // Create notification
  await c.env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, title, message, metadata)
     VALUES (?, ?, 'transform_complete', 'Spec Transformation Complete', ?, ?)`
  ).bind(
    generateId('notif'), user.id,
    `Spec breakdown ready for ${project.name}.`,
    JSON.stringify({ project_id: projectId, breakdown_id: breakdownId })
  ).run().catch(() => {/* non-fatal */});

  return c.json({
    success: true,
    data: {
      breakdown_id: breakdownId,
      feature_map: structured.feature_map ?? [],
      screen_map: structured.screen_map ?? [],
      data_model: structured.data_model ?? [],
      api_contracts: structured.api_contracts ?? [],
      arch_summary: structured.arch_summary ?? aiResult.output?.slice(0, 2000) ?? '',
      deployment_reqs: structured.deployment_reqs ?? [],
      env_vars: structured.env_vars ?? [],
      risk_flags: structured.risk_flags ?? [],
      readiness_score: structured.readiness_score ?? 75,
      coins_used: coinCost,
    },
    message: `Specification transformed! ${coinCost} coins used.`,
  });
});

// ── GET /api/projects/:id/transform ────────────────────────────────────────────
// Retrieve the latest saved spec breakdown for a project.
projects.get('/:id/transform', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('id');

  const breakdown = await c.env.DB.prepare(
    `SELECT * FROM spec_breakdowns WHERE project_id = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(projectId, user.id).first<Record<string, unknown>>();

  if (!breakdown) {
    return c.json({ success: false, error: 'No spec breakdown found. Run a transformation first.' }, 404);
  }

  // Parse JSON fields
  const parse = (v: unknown) => {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  };

  return c.json({
    success: true,
    data: {
      id: breakdown.id,
      job_id: breakdown.job_id,
      feature_map: parse(breakdown.feature_map),
      screen_map: parse(breakdown.screen_map),
      data_model: parse(breakdown.data_model),
      api_contracts: parse(breakdown.api_contracts),
      arch_summary: breakdown.arch_summary,
      deployment_reqs: parse(breakdown.deployment_reqs),
      env_vars: parse(breakdown.env_vars),
      risk_flags: parse(breakdown.risk_flags),
      readiness_score: breakdown.readiness_score,
      created_at: breakdown.created_at,
    },
  });
});

export default projects;
