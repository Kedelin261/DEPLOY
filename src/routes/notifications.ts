// DEPLOY Platform - Notifications Routes

import { Hono } from 'hono';
import { authMiddleware, generateId } from '../middleware/auth';
import type { Bindings, Variables } from '../types';

const notifications = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/notifications
notifications.get('/', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const unreadOnly = c.req.query('unread') === 'true';

  const query = unreadOnly
    ? 'SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 20'
    : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30';

  const [notifs, unreadCount] = await Promise.all([
    c.env.DB.prepare(query).bind(user.id).all(),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM notifications WHERE user_id = ? AND is_read = 0').bind(user.id).first<{ total: number }>()
  ]);

  return c.json({
    success: true,
    data: {
      notifications: notifs.results,
      unread_count: unreadCount?.total || 0
    }
  });
});

// PUT /api/notifications/read-all
notifications.put('/read-all', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(user.id).run();
  return c.json({ success: true, message: 'All notifications marked as read' });
});

// PUT /api/notifications/:id/read
notifications.put('/:id/read', authMiddleware(), async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return c.json({ success: true });
});

export default notifications;
