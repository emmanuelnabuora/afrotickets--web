// src/routes/notifications.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Only the in_app channel is meant for direct display — email/sms/whatsapp
// rows are the same event logged for the other (stubbed) delivery channels,
// and showing all of them here would triple up every notification the user
// actually sees.
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT id, type, payload, sent_at, read_at FROM notifications
     WHERE user_id = $1 AND channel = 'in_app'
     ORDER BY sent_at DESC LIMIT 100`,
    [req.user.sub]
  );
  const notifications = rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload),
    sentAt: r.sent_at,
    read: !!r.read_at,
  }));
  res.json({ notifications });
});

router.post('/:id/read', requireAuth, async (req, res) => {
  const notif = await db.one('SELECT * FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.sub]);
  if (!notif) return res.status(404).json({ error: 'Notification not found' });
  await db.query('UPDATE notifications SET read_at = now() WHERE id = $1', [notif.id]);
  res.json({ message: 'Marked as read' });
});

router.post('/read-all', requireAuth, async (req, res) => {
  await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user.sub]);
  res.json({ message: 'All notifications marked as read' });
});

module.exports = router;
