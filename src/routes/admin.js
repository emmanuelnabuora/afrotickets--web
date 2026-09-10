// src/routes/admin.js
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');

const router = express.Router();
router.use(requireAuth, requireRole('platform_admin'));

router.get('/organizers/pending', async (req, res) => {
  const rows = await db.query(`SELECT * FROM organizers WHERE verification_status = 'pending'`);
  res.json({ organizers: rows });
});

router.post('/organizers/:id/approve', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  await db.query(`UPDATE organizers SET verification_status = 'approved' WHERE id = $1`, [org.id]);
  await audit(req.user.sub, 'organizer.approved', 'organizer', org.id, {});
  await notify(org.owner_user_id, 'organizer.approved', { organizerId: org.id }, ['in_app', 'email']);
  res.json({ message: 'Organizer approved' });
});

router.post('/organizers/:id/reject', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  await db.query(`UPDATE organizers SET verification_status = 'rejected' WHERE id = $1`, [org.id]);
  await audit(req.user.sub, 'organizer.rejected', 'organizer', org.id, { reason: req.body?.reason });
  await notify(org.owner_user_id, 'organizer.rejected', { organizerId: org.id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Organizer rejected' });
});

router.get('/events/pending', async (req, res) => {
  const rows = await db.query(
    `SELECT e.*, o.name AS organizer_name, o.verification_status AS organizer_status
     FROM events e JOIN organizers o ON o.id = e.organizer_id
     WHERE e.status = 'pending_review'`
  );
  res.json({ events: rows });
});

router.post('/events/:id/approve', async (req, res) => {
  const event = await db.one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [event.organizer_id]);
  if (org.verification_status !== 'approved') {
    return res.status(409).json({ error: 'Organizer is not yet verified — approve the organizer first' });
  }
  await db.query(`UPDATE events SET status = 'published' WHERE id = $1`, [event.id]);
  await audit(req.user.sub, 'event.approved', 'event', event.id, {});
  await notify(org.owner_user_id, 'event.published', { eventId: event.id }, ['in_app', 'email']);
  res.json({ message: 'Event published' });
});

router.post('/events/:id/reject', async (req, res) => {
  const event = await db.one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  await db.query(`UPDATE events SET status = 'rejected' WHERE id = $1`, [event.id]);
  await audit(req.user.sub, 'event.rejected', 'event', event.id, { reason: req.body?.reason });
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [event.organizer_id]);
  await notify(org.owner_user_id, 'event.rejected', { eventId: event.id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Event rejected' });
});

router.post('/tickets/:id/invalidate', async (req, res) => {
  const ticket = await db.one('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  await db.query(`UPDATE tickets SET status = 'invalidated' WHERE id = $1`, [ticket.id]);
  await audit(req.user.sub, 'ticket.invalidated', 'ticket', ticket.id, { reason: req.body?.reason });
  await notify(ticket.owner_user_id, 'ticket.invalidated', { ticketId: ticket.id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Ticket invalidated' });
});

router.get('/audit-log', async (req, res) => {
  const rows = await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100');
  res.json({ auditLog: rows });
});

router.get('/fraud-signals', async (req, res) => {
  const rows = await db.query(
    `SELECT fs.*, u.name AS user_name, u.email AS user_email, e.name AS event_name
     FROM fraud_signals fs
     LEFT JOIN users u ON u.id = fs.user_id
     LEFT JOIN events e ON e.id = fs.event_id
     WHERE fs.status = 'open'
     ORDER BY fs.id DESC`
  );
  res.json({ fraudSignals: rows });
});

router.post('/fraud-signals/:id/clear', async (req, res) => {
  const signal = await db.one('SELECT * FROM fraud_signals WHERE id = $1', [req.params.id]);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  await db.query(`UPDATE fraud_signals SET status = 'cleared' WHERE id = $1`, [signal.id]);
  await audit(req.user.sub, 'fraud_signal.cleared', 'fraud_signal', signal.id, {});
  res.json({ message: 'Signal cleared' });
});

router.post('/fraud-signals/:id/action', async (req, res) => {
  const signal = await db.one('SELECT * FROM fraud_signals WHERE id = $1', [req.params.id]);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  await db.query(`UPDATE fraud_signals SET status = 'actioned' WHERE id = $1`, [signal.id]);
  await audit(req.user.sub, 'fraud_signal.actioned', 'fraud_signal', signal.id, { note: req.body?.note });
  res.json({ message: 'Signal marked actioned' });
});

module.exports = router;
