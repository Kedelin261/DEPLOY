// DEPLOY Platform — Planning/Kanban Task Routes
// Full CRUD for planning_tasks with column management.
// GET    /api/planning              — list user's tasks (optionally filtered by project)
// POST   /api/planning              — create task
// PUT    /api/planning/:id          — update task (title, description, column, priority, order)
// DELETE /api/planning/:id          — delete task
// PUT    /api/planning/:id/move     — move to column + reorder

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const planning = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const VALID_COLUMNS = ['todo', 'in_progress', 'done', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// GET /api/planning
planning.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const projectId = c.req.query('project_id');
  const column = c.req.query('column');

  let query = `SELECT t.*, p.name as project_name
               FROM planning_tasks t
               LEFT JOIN projects p ON p.id = t.project_id
               WHERE t.user_id = ?`;
  const binds: unknown[] = [user.id];

  if (projectId) { query += ' AND t.project_id = ?'; binds.push(projectId); }
  if (column)    { query += ' AND t.column_id = ?';  binds.push(column); }

  query += ' ORDER BY t.column_id ASC, t.sort_order ASC, t.created_at DESC';

  const stmt = c.env.DB.prepare(query);
  const result = await stmt.bind(...binds).all();

  // Group by column for a Kanban-ready response
  const byColumn: Record<string, unknown[]> = {
    todo: [], in_progress: [], done: [], blocked: []
  };
  for (const task of result.results) {
    const col = (task as { column_id: string }).column_id || 'todo';
    if (!byColumn[col]) byColumn[col] = [];
    byColumn[col].push(task);
  }

  return c.json({ success: true, data: { tasks: result.results, by_column: byColumn } });
});

// POST /api/planning
planning.post('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json();
  const {
    title, description, column_id = 'todo',
    priority = 'medium', project_id, due_date, tags
  } = body;

  if (!title?.trim()) {
    return c.json({ success: false, error: 'Title is required' }, 400);
  }
  if (!VALID_COLUMNS.includes(column_id)) {
    return c.json({ success: false, error: `column_id must be one of: ${VALID_COLUMNS.join(', ')}` }, 400);
  }
  if (!VALID_PRIORITIES.includes(priority)) {
    return c.json({ success: false, error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` }, 400);
  }

  // If project_id given, verify ownership
  if (project_id) {
    const proj = await c.env.DB.prepare(
      'SELECT id FROM projects WHERE id = ? AND user_id = ?'
    ).bind(project_id, user.id).first();
    if (!proj) return c.json({ success: false, error: 'Project not found' }, 404);
  }

  // Get next sort_order for this column
  const maxOrder = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as mx FROM planning_tasks WHERE user_id = ? AND column_id = ?'
  ).bind(user.id, column_id).first<{ mx: number }>();

  const taskId = generateId('task');
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || null);

  await c.env.DB.prepare(
    `INSERT INTO planning_tasks (id, user_id, project_id, column_id, title, description, priority, sort_order, due_date, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    taskId, user.id, project_id || null, column_id,
    title.trim(), description || null, priority,
    (maxOrder?.mx ?? -1) + 1,
    due_date || null, tagsJson
  ).run();

  const task = await c.env.DB.prepare(
    'SELECT * FROM planning_tasks WHERE id = ?'
  ).bind(taskId).first();

  return c.json({ success: true, data: task }, 201);
});

// PUT /api/planning/:id
planning.put('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const taskId = c.req.param('id');

  const task = await c.env.DB.prepare(
    'SELECT * FROM planning_tasks WHERE id = ? AND user_id = ?'
  ).bind(taskId, user.id).first();
  if (!task) return c.json({ success: false, error: 'Task not found' }, 404);

  const body = await c.req.json();
  const fields: Record<string, unknown> = {};

  if (body.title !== undefined)       fields['title'] = body.title.trim();
  if (body.description !== undefined) fields['description'] = body.description;
  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority))
      return c.json({ success: false, error: 'Invalid priority' }, 400);
    fields['priority'] = body.priority;
  }
  if (body.column_id !== undefined) {
    if (!VALID_COLUMNS.includes(body.column_id))
      return c.json({ success: false, error: 'Invalid column_id' }, 400);
    fields['column_id'] = body.column_id;
  }
  if (body.sort_order !== undefined) fields['sort_order'] = body.sort_order;
  if (body.due_date !== undefined)   fields['due_date'] = body.due_date;
  if (body.tags !== undefined)       fields['tags'] = Array.isArray(body.tags) ? JSON.stringify(body.tags) : body.tags;

  if (Object.keys(fields).length === 0) {
    return c.json({ success: false, error: 'No updatable fields provided' }, 400);
  }

  fields['updated_at'] = new Date().toISOString();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), taskId];

  await c.env.DB.prepare(
    `UPDATE planning_tasks SET ${setClauses} WHERE id = ?`
  ).bind(...values).run();

  const updated = await c.env.DB.prepare('SELECT * FROM planning_tasks WHERE id = ?').bind(taskId).first();
  return c.json({ success: true, data: updated });
});

// PUT /api/planning/:id/move — move card to column, set sort_order
planning.put('/:id/move', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const taskId = c.req.param('id');
  const { column_id, sort_order } = await c.req.json();

  if (!VALID_COLUMNS.includes(column_id)) {
    return c.json({ success: false, error: 'Invalid column_id' }, 400);
  }

  const task = await c.env.DB.prepare(
    'SELECT id FROM planning_tasks WHERE id = ? AND user_id = ?'
  ).bind(taskId, user.id).first();
  if (!task) return c.json({ success: false, error: 'Task not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE planning_tasks SET column_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(column_id, sort_order ?? 0, taskId).run();

  return c.json({ success: true, message: 'Task moved' });
});

// DELETE /api/planning/:id
planning.delete('/:id', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const taskId = c.req.param('id');

  const result = await c.env.DB.prepare(
    'DELETE FROM planning_tasks WHERE id = ? AND user_id = ?'
  ).bind(taskId, user.id).run();

  if (!result.meta.changes) {
    return c.json({ success: false, error: 'Task not found' }, 404);
  }

  return c.json({ success: true, message: 'Task deleted' });
});

export default planning;
