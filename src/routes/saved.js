// src/routes/saved.js
const express = require('express');
const db = require('../db');

const router = express.Router();
const { requireAuth } = require('../auth');

router.post('/:eventId', requireAuth, async (req, res) => {
  const event = await db.one('SELECT id FROM events WHERE id = $1 AND status = $2', [req.params.eventId, 'published']);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  await db.query(
    `INSERT INTO saved_events (user_id, event_id) VALUES ($1, $2) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [req.user.sub, req.params.eventId]
  );
  res.status(201).json({ message: 'Event saved' });
});

router.delete('/:eventId', requireAuth, async (req, res) => {
  await db.query('DELETE FROM saved_events WHERE user_id = $1 AND event_id = $2', [req.user.sub, req.params.eventId]);
  res.json({ message: 'Event unsaved' });
});

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT e.* FROM saved_events se
     JOIN events e ON e.id = se.event_id
     WHERE se.user_id = $1 AND e.status = 'published'
     ORDER BY se.created_at DESC`,
    [req.user.sub]
  );
  res.json({ events: rows });
});

module.exports = router;
