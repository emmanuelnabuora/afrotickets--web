// src/routes/organizers.js
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../utils/audit');

const router = express.Router();

async function getOwnedOrganizerOrFail(userId) {
  return db.one('SELECT * FROM organizers WHERE owner_user_id = $1', [userId]);
}

router.post('/onboard', requireAuth, requireRole('organizer_owner', 'platform_admin'), async (req, res) => {
  const { name, country, settlementMethod, settlementAccount } = req.body;
  if (!name || !country) return res.status(400).json({ error: 'name and country are required' });

  const existing = await getOwnedOrganizerOrFail(req.user.sub);
  if (existing) return res.json({ organizer: existing });

  const created = await db.one(
    `INSERT INTO organizers (owner_user_id, name, country, settlement_method, settlement_account)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.sub, name, country, settlementMethod || null, settlementAccount || null]
  );

  await audit(req.user.sub, 'organizer.onboarded', 'organizer', created.id, { name, country });
  res.status(201).json({ organizer: created });
});

router.get('/me', requireAuth, async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  if (!organizer) return res.status(404).json({ error: 'No organizer profile yet — call POST /onboard first' });
  res.json({ organizer });
});

router.post('/events', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  if (!organizer) return res.status(400).json({ error: 'Complete organizer onboarding first' });

  const { name, category, description, venue, city, country, startsAt, currency, ticketTypes } = req.body;
  if (!name || !category || !startsAt || !Array.isArray(ticketTypes) || ticketTypes.length === 0) {
    return res.status(400).json({ error: 'name, category, startsAt, and at least one ticket type are required' });
  }

  const event = await db.one(
    `INSERT INTO events (organizer_id, name, category, description, venue, city, country, starts_at, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_review') RETURNING *`,
    [organizer.id, name, category, description || '', venue || '', city || '', country || '', startsAt, currency || 'USD']
  );

  const types = [];
  for (const tt of ticketTypes) {
    const created = await db.one(
      'INSERT INTO ticket_types (event_id, name, price_cents, quantity_total) VALUES ($1, $2, $3, $4) RETURNING *',
      [event.id, tt.name, Math.round(tt.price * 100), tt.quantity]
    );
    types.push(created);
  }

  await audit(req.user.sub, 'event.created', 'event', event.id, { name, status: 'pending_review' });
  res.status(201).json({ event, ticketTypes: types });
});

router.get('/events/mine', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  if (!organizer) return res.json({ events: [] });
  const events = await db.query('SELECT * FROM events WHERE organizer_id = $1 AND deleted_at IS NULL', [organizer.id]);
  res.json({ events });
});

router.post('/events/:id/seats', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await db.one('SELECT * FROM events WHERE id = $1 AND organizer_id = $2', [req.params.id, organizer?.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { ticketTypeId, sectionName, tier, rows, seatsPerRow } = req.body;
  const ticketType = await db.one('SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2', [ticketTypeId, event.id]);
  if (!ticketType) return res.status(404).json({ error: 'Ticket type not found on this event' });
  if (!sectionName || !rows || !seatsPerRow) {
    return res.status(400).json({ error: 'sectionName, rows, and seatsPerRow are required' });
  }
  const seatCount = rows * seatsPerRow;
  if (seatCount > ticketType.quantity_total) {
    return res.status(400).json({ error: `${seatCount} seats exceeds this ticket type's quantity_total of ${ticketType.quantity_total}` });
  }

  const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  try {
    await db.withTransaction(async (tx) => {
      for (let r = 0; r < rows; r++) {
        for (let n = 1; n <= seatsPerRow; n++) {
          await tx.query(
            `INSERT INTO event_seats (event_id, ticket_type_id, section_name, tier, row_label, seat_number) VALUES ($1, $2, $3, $4, $5, $6)`,
            [event.id, ticketType.id, sectionName, tier || 'b', rowLetters[r] || String(r + 1), n]
          );
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not generate seats', detail: err.message });
  }
  await audit(req.user.sub, 'event.seats_generated', 'event', event.id, { sectionName, seatCount });
  res.status(201).json({ message: `Generated ${seatCount} seats in ${sectionName}` });
});

router.get('/events/:id/analytics', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await db.one('SELECT * FROM events WHERE id = $1 AND organizer_id = $2', [req.params.id, organizer?.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const grossRow = await db.one(
    `SELECT COALESCE(SUM(total_cents),0) AS cents FROM orders WHERE event_id = $1 AND status = 'paid'`,
    [event.id]
  );
  const soldRow = await db.one(`SELECT COUNT(*) AS n FROM tickets WHERE event_id = $1 AND status != 'invalidated'`, [event.id]);
  const byType = await db.query('SELECT tt.name, tt.quantity_total, tt.quantity_sold, tt.price_cents FROM ticket_types tt WHERE tt.event_id = $1', [event.id]);
  const checkedInRow = await db.one(`SELECT COUNT(*) AS n FROM tickets WHERE event_id = $1 AND status = 'checked_in'`, [event.id]);

  res.json({
    event: { id: event.id, name: event.name, currency: event.currency, status: event.status },
    grossSalesCents: Number(grossRow.cents),
    ticketsSold: Number(soldRow.n),
    checkedIn: Number(checkedInRow.n),
    byTicketType: byType,
  });
});

module.exports = router;
