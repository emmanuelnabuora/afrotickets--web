// src/routes/tickets.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const { ticketQrDataUrl, signTicketToken } = require('../utils/qrTicket');
const { transferLimiter } = require('../security');

const router = express.Router();

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT t.*, e.name AS event_name, e.starts_at, e.venue, e.city, tt.name AS ticket_type_name
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN ticket_types tt ON tt.id = t.ticket_type_id
     WHERE t.owner_user_id = $1
     ORDER BY e.starts_at ASC`,
    [req.user.sub]
  );

  const tickets = await Promise.all(
    rows.map(async (t) => {
      const seat = await db.one('SELECT section_name, row_label, seat_number FROM event_seats WHERE ticket_id = $1', [t.id]);
      return {
        id: t.id,
        status: t.status,
        origin: t.origin,
        eventName: t.event_name,
        startsAt: t.starts_at,
        venue: t.venue,
        city: t.city,
        ticketType: t.ticket_type_name,
        checkedInAt: t.checked_in_at,
        seat: seat ? { section: seat.section_name, row: seat.row_label, number: seat.seat_number } : null,
        qrDataUrl: t.status === 'valid' ? await ticketQrDataUrl(t.qr_token) : null,
        qrToken: t.status === 'valid' ? t.qr_token : null,
      };
    })
  );
  res.json({ tickets });
});

router.post('/:id/transfer', requireAuth, transferLimiter, async (req, res) => {
  const { toEmail } = req.body;
  if (!toEmail) return res.status(400).json({ error: 'toEmail is required' });

  const ticket = await db.one('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  if (!ticket || ticket.owner_user_id !== req.user.sub) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  if (ticket.status !== 'valid') {
    return res.status(409).json({ error: `Ticket cannot be transferred — current status: ${ticket.status}` });
  }
  const toUser = await db.one('SELECT * FROM users WHERE email = $1', [toEmail]);
  if (!toUser) return res.status(404).json({ error: 'No AfroTickets account found with that email' });
  if (toUser.id === req.user.sub) return res.status(400).json({ error: 'Cannot transfer a ticket to yourself' });

  try {
    await db.withTransaction(async (tx) => {
      const { token, jti } = signTicketToken({
        eventId: ticket.event_id,
        ticketTypeId: ticket.ticket_type_id,
        ownerUserId: toUser.id,
      });
      await tx.query('UPDATE tickets SET owner_user_id = $1, qr_jti = $2, qr_token = $3 WHERE id = $4', [toUser.id, jti, token, ticket.id]);
      await tx.query(
        `INSERT INTO ticket_transfers (ticket_id, from_user_id, to_user_id, reason) VALUES ($1, $2, $3, 'transfer')`,
        [ticket.id, req.user.sub, toUser.id]
      );
    });
  } catch (err) {
    return res.status(500).json({ error: 'Transfer failed', detail: err.message });
  }

  await audit(req.user.sub, 'ticket.transferred', 'ticket', ticket.id, { toUserId: toUser.id });
  await notify(toUser.id, 'ticket.received', { ticketId: ticket.id }, ['in_app', 'email']);
  await notify(req.user.sub, 'ticket.transferred', { ticketId: ticket.id, toEmail }, ['in_app']);

  res.json({ message: `Ticket transferred to ${toEmail}` });
});

module.exports = router;
