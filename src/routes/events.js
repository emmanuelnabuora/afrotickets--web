// src/routes/events.js
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const events = await db.query(
    `SELECT * FROM events WHERE status = 'published' AND deleted_at IS NULL ORDER BY starts_at ASC`
  );
  res.json({ events });
});

router.get('/:id', async (req, res) => {
  const event = await db.one(
    `SELECT * FROM events WHERE id = $1 AND status = 'published' AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const ticketTypes = await db.query(
    `SELECT id, name, price_cents, quantity_total, quantity_reserved, quantity_sold,
            (quantity_total - quantity_reserved - quantity_sold) AS available
     FROM ticket_types WHERE event_id = $1 AND deleted_at IS NULL`,
    [event.id]
  );
  const seatCountRow = await db.one('SELECT COUNT(*) AS n FROM event_seats WHERE event_id = $1', [event.id]);
  res.json({ event, ticketTypes, hasSeatmap: Number(seatCountRow.n) > 0 });
});

router.get('/:id/seats', async (req, res) => {
  const event = await db.one(`SELECT * FROM events WHERE id = $1 AND status = 'published'`, [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const seats = await db.query(
    `SELECT es.id, es.section_name, es.tier, es.row_label, es.seat_number, es.status, tt.id AS ticket_type_id, tt.price_cents, tt.name AS ticket_type_name
     FROM event_seats es JOIN ticket_types tt ON tt.id = es.ticket_type_id
     WHERE es.event_id = $1 ORDER BY es.section_name, es.row_label, es.seat_number`,
    [req.params.id]
  );
  res.json({ eventId: Number(req.params.id), seats });
});

module.exports = router;
