// DEPLOY Platform — R2 File Upload Routes
// POST /api/uploads/:project_id   — upload a file (max 10MB)
// GET  /api/uploads/:project_id   — list files for project
// DELETE /api/uploads/:file_id    — delete a file
// GET  /api/uploads/file/:file_id — get file metadata

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const uploads = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
  'application/pdf','application/json','text/plain','text/csv','text/markdown',
  'application/zip','application/x-zip-compressed',
  'video/mp4','video/webm',
]);

// POST /api/uploads/:project_id
uploads.post('/:project_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  // Verify project ownership
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  // Check plan upload limits
  const plan = await c.env.DB.prepare(
    `SELECT p.max_uploads FROM plans p
     JOIN memberships m ON m.plan_id = p.id WHERE m.user_id = ?`
  ).bind(user.id).first<{ max_uploads: number }>();

  const currentCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM uploaded_files WHERE project_id = ?'
  ).bind(projectId).first<{ total: number }>();

  const maxUploads = plan?.max_uploads ?? 5;
  if ((currentCount?.total ?? 0) >= maxUploads) {
    return c.json({
      success: false,
      error: `Your plan allows ${maxUploads} uploads per project. Upgrade for more.`
    }, 403);
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ success: false, error: 'Expected multipart/form-data request' }, 400);
  }

  const file = formData.get('file') as File | null;
  if (!file || typeof file === 'string') {
    return c.json({ success: false, error: 'No file field found in form data' }, 400);
  }

  // Validate size
  if (file.size > MAX_SIZE_BYTES) {
    return c.json({ success: false, error: `File too large. Maximum size is 10 MB.` }, 413);
  }

  // Validate type
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_TYPES.has(contentType)) {
    return c.json({ success: false, error: `File type "${contentType}" is not allowed.` }, 415);
  }

  // Sanitise filename
  const rawName = file.name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
  const fileId = generateId('file');
  const r2Key = `uploads/${user.id}/${projectId}/${fileId}/${rawName}`;

  // Upload to R2
  try {
    await c.env.DEPLOY_R2.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType },
      customMetadata: {
        upload_id: fileId,
        user_id: user.id,
        project_id: projectId,
        original_name: rawName,
      },
    });
  } catch (r2Err) {
    console.error('[Upload] R2 put error:', r2Err);
    return c.json({ success: false, error: 'Storage upload failed. Please try again.' }, 500);
  }

  // Write metadata to D1
  await c.env.DB.prepare(
    `INSERT INTO uploaded_files (id, user_id, project_id, r2_key, original_name, content_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(fileId, user.id, projectId, r2Key, rawName, contentType, file.size).run();

  // Audit
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id)
     VALUES (?, ?, 'file_uploaded', 'uploaded_file', ?)`
  ).bind(generateId('log'), user.id, fileId).run().catch(() => {});

  return c.json({
    success: true,
    data: { id: fileId, r2_key: r2Key, original_name: rawName, size_bytes: file.size, content_type: contentType },
    message: 'File uploaded successfully'
  }, 201);
});

// GET /api/uploads/:project_id — list files for a project
uploads.get('/:project_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.param('project_id');

  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?'
  ).bind(projectId, user.id).first();
  if (!project) return c.json({ success: false, error: 'Project not found' }, 404);

  const files = await c.env.DB.prepare(
    `SELECT id, original_name, content_type, size_bytes, r2_key, created_at
     FROM uploaded_files WHERE project_id = ? ORDER BY created_at DESC`
  ).bind(projectId).all();

  return c.json({ success: true, data: files.results });
});

// GET /api/uploads/file/:file_id — serve file with a presigned-like redirect
uploads.get('/file/:file_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const fileId = c.req.param('file_id');

  const meta = await c.env.DB.prepare(
    'SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?'
  ).bind(fileId, user.id).first<{ r2_key: string; original_name: string; content_type: string }>();

  if (!meta) return c.json({ success: false, error: 'File not found' }, 404);

  // Serve directly from R2
  const object = await c.env.DEPLOY_R2.get(meta.r2_key);
  if (!object) return c.json({ success: false, error: 'File not in storage' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': meta.content_type,
      'Content-Disposition': `inline; filename="${meta.original_name}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// DELETE /api/uploads/:file_id — delete a file
uploads.delete('/:file_id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const fileId = c.req.param('file_id');

  const meta = await c.env.DB.prepare(
    'SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?'
  ).bind(fileId, user.id).first<{ r2_key: string }>();

  if (!meta) return c.json({ success: false, error: 'File not found' }, 404);

  // Delete from R2
  try {
    await c.env.DEPLOY_R2.delete(meta.r2_key);
  } catch (err) {
    console.error('[Upload] R2 delete error:', err);
  }

  // Delete from D1
  await c.env.DB.prepare('DELETE FROM uploaded_files WHERE id = ?').bind(fileId).run();

  return c.json({ success: true, message: 'File deleted' });
});

export default uploads;
