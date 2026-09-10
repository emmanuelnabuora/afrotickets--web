// src/routes/checkin.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { verifyTicketToken } = require('../utils/qrTicket');
const { audit } = require('../utils/audit');

const router = express.Router();
const MANIFEST_SECRET = process.env.MANIFEST_SECRET || 'dev-manifest-secret-change-me';

async function checkInByJti(jti, scannedAt, actorUserId) {
  const ticket = await db.one('SELECT * FROM tickets WHERE qr_jti = $1', [jti]);
  if (!ticket) return { result: 'unknown', jti };
  if (ticket.status === 'checked_in') {
    return { result: 'duplicate', jti, checkedInAt: ticket.checked_in_at };
  }
  if (ticket.status !== 'valid') {
    return { result: 'invalid', jti, status: ticket.status };
  }
  const ts = scannedAt || new Date().toISOString();
  await db.query(`UPDATE tickets SET status = 'checked_in', checked_in_at = $1 WHERE id = $2`, [ts, ticket.id]);
  await audit(actorUserId, 'ticket.checked_in', 'ticket', ticket.id, { jti });
  return { result: 'success', jti, ticketId: ticket.id, checkedInAt: ts };
}

router.post('/scan', requireAuth, requireRole('organizer_owner', 'checkin_staff', 'platform_admin'), async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  let decoded;
  try {
    decoded = verifyTicketToken(token);
  } catch (err) {
    return res.status(400).json({ result: 'invalid_signature', error: 'This QR code is not a valid AfroTickets ticket' });
  }
  const outcome = await checkInByJti(decoded.jti, null, req.user.sub);
  const status = outcome.result === 'success' ? 200 : outcome.result === 'duplicate' ? 409 : 410;
  res.status(status).json(outcome);
});

router.get('/manifest/:eventId', requireAuth, requireRole('organizer_owner', 'checkin_staff', 'platform_admin'), async (req, res) => {
  const rows = await db.query('SELECT qr_jti, ticket_type_id, status FROM tickets WHERE event_id = $1', [req.params.eventId]);
  const generatedAt = new Date().toISOString();
  const entries = rows.map((r) => ({ jti: r.qr_jti, ticketTypeId: r.ticket_type_id, status: r.status }));
  const body = JSON.stringify({ eventId: Number(req.params.eventId), generatedAt, entries });
  const signature = crypto.createHmac('sha256', MANIFEST_SECRET).update(body).digest('hex');
  res.json({ eventId: Number(req.params.eventId), generatedAt, entries, signature });
});

router.post('/sync', requireAuth, requireRole('organizer_owner', 'checkin_staff', 'platform_admin'), async (req, res) => {
  const { scans } = req.body;
  if (!Array.isArray(scans)) return res.status(400).json({ error: 'scans array is required' });
  const results = [];
  for (const s of scans) {
    results.push(await checkInByJti(s.jti, s.scannedAt, req.user.sub));
  }
  res.json({ results });
});

module.exports = router;
