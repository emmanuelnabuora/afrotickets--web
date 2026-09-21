// src/routes/organizers.js
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const imageStorage = require('../utils/imageStorage');
const pii = require('../utils/piiCrypto');
const { validateEventCreation, validateTicketTypeCreation, validateSeatGeneration } = require('../security');

const router = express.Router();

// settlement_account is stored encrypted (see utils/piiCrypto.js) — decrypt
// it only at the point of handing an organizer record back to its own owner
// or a platform admin, never before.
function decorateOrganizer(org) {
  if (!org) return org;
  return { ...org, settlement_account: pii.decrypt(org.settlement_account) };
}

async function getOwnedOrganizerOrFail(userId) {
  return db.one('SELECT * FROM organizers WHERE owner_user_id = $1', [userId]);
}

async function getOwnedEventOrFail(userId, eventId) {
  const organizer = await getOwnedOrganizerOrFail(userId);
  if (!organizer) return null;
  return db.one('SELECT * FROM events WHERE id = $1 AND organizer_id = $2 AND deleted_at IS NULL', [eventId, organizer.id]);
}

// A suspended organizer (see admin.js's suspend/reactivate) can't build out
// their footprint further — create events, edit them, add seats, or change
// imagery — but deliberately CAN still cancel or postpone an existing event,
// since those protect ticket holders (a customer shouldn't be stuck with a
// dead event just because its organizer is under review) and read-only
// endpoints (GET /me, /events/mine, analytics) stay open so a suspended
// organizer can still see their own status and history.
function blockIfSuspended(organizer, res) {
  if (organizer.verification_status === 'suspended') {
    res.status(403).json({
      error: `Your organizer account is suspended${organizer.suspension_reason ? `: ${organizer.suspension_reason}` : ''} — contact support to resolve this before making further changes.`,
    });
    return true;
  }
  return false;
}

router.post('/onboard', requireAuth, requireRole('organizer_owner', 'platform_admin'), async (req, res) => {
  const { name, country, settlementMethod, settlementAccount } = req.body;
  if (!name || !country) return res.status(400).json({ error: 'name and country are required' });

  const existing = await getOwnedOrganizerOrFail(req.user.sub);
  if (existing) return res.json({ organizer: decorateOrganizer(existing) });

  const created = await db.one(
    `INSERT INTO organizers (owner_user_id, name, country, settlement_method, settlement_account)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.sub, name, country, settlementMethod || null, pii.encrypt(settlementAccount) || null]
  );

  await audit(req.user.sub, 'organizer.onboarded', 'organizer', created.id, { name, country });
  res.status(201).json({ organizer: decorateOrganizer(created) });
});

router.get('/me', requireAuth, async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  if (!organizer) return res.status(404).json({ error: 'No organizer profile yet — call POST /onboard first' });
  res.json({ organizer: decorateOrganizer(organizer) });
});

router.post('/events', requireAuth, requireRole('organizer_owner'), validateEventCreation, validateTicketTypeCreation, async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  if (!organizer) return res.status(400).json({ error: 'Complete organizer onboarding first' });
  if (blockIfSuspended(organizer, res)) return;

  const { name, category, description, venue, city, country, startsAt, currency, ticketTypes, resaleEnabled } = req.body;

  // resaleEnabled defaults to true (matches pre-existing behavior — resale
  // was always globally available); explicitly passing false opts this
  // event out of resale from the moment it's created.
  const event = await db.one(
    `INSERT INTO events (organizer_id, name, category, description, venue, city, country, starts_at, currency, status, resale_disabled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_review', $10) RETURNING *`,
    [organizer.id, name, category, description || '', venue || '', city || '', country || '', startsAt, currency || 'USD', resaleEnabled === false ? new Date().toISOString() : null]
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

router.post('/events/:id/seats', requireAuth, requireRole('organizer_owner'), validateSeatGeneration, async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await db.one('SELECT * FROM events WHERE id = $1 AND organizer_id = $2', [req.params.id, organizer?.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (blockIfSuspended(organizer, res)) return;

  const { ticketTypeId, sectionName, tier, rows, seatsPerRow } = req.body;
  const ticketType = await db.one('SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2', [ticketTypeId, event.id]);
  if (!ticketType) return res.status(404).json({ error: 'Ticket type not found on this event' });
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

// ===================== EDIT / CANCEL / POSTPONE =====================

// Fields that never affect a ticket holder's expectations, so they're
// editable at any time. Anything that does (venue/city/country/currency/
// date) is locked once a single ticket has actually sold — a date change
// specifically has its own endpoint (/postpone) because it needs to notify
// ticket holders, which a generic PATCH shouldn't silently do.
const EDITABLE_ALWAYS = { name: 'name', category: 'category', description: 'description' };
const EDITABLE_IF_UNSOLD = { venue: 'venue', city: 'city', country: 'country', currency: 'currency', startsAt: 'starts_at' };

router.patch('/events/:id', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await getOwnedEventOrFail(req.user.sub, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (blockIfSuspended(organizer, res)) return;
  if (event.status === 'cancelled') return res.status(400).json({ error: 'Cannot edit a cancelled event' });

  const soldRow = await db.one('SELECT COALESCE(SUM(quantity_sold),0) AS sold FROM ticket_types WHERE event_id = $1', [event.id]);
  const hasSold = Number(soldRow.sold) > 0;

  const updates = {};
  const blocked = [];
  for (const [field, column] of Object.entries(EDITABLE_ALWAYS)) {
    if (req.body[field] !== undefined) updates[column] = req.body[field];
  }
  for (const [field, column] of Object.entries(EDITABLE_IF_UNSOLD)) {
    if (req.body[field] !== undefined) {
      if (hasSold) blocked.push(field);
      else updates[column] = req.body[field];
    }
  }
  if (blocked.length > 0) {
    const suffix = blocked.includes('startsAt') ? ' — use POST /events/:id/postpone to reschedule instead' : '';
    return res.status(400).json({ error: `Cannot change ${blocked.join(', ')} once tickets have been sold${suffix}` });
  }
  // Toggling resale never affects a ticket holder's expectations (it only
  // gates NEW listings going forward — see routes/resale.js), so it's
  // editable at any time, sold-out event or not.
  if (typeof req.body.resaleEnabled === 'boolean') {
    updates.resale_disabled_at = req.body.resaleEnabled ? null : new Date().toISOString();
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }

  const columns = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
  values.push(event.id);
  const updated = await db.one(`UPDATE events SET ${setClause} WHERE id = $${values.length} RETURNING *`, values);

  await audit(req.user.sub, 'event.updated', 'event', event.id, { fields: columns });
  res.json({ event: updated });
});

router.post('/events/:id/cancel', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const event = await getOwnedEventOrFail(req.user.sub, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status === 'cancelled') return res.status(400).json({ error: 'Event is already cancelled' });

  const reason = req.body?.reason || null;

  await db.query(
    `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $1 WHERE id = $2`,
    [reason, event.id]
  );

  // Invalidating every live ticket alone blocks check-in and resale, since
  // both already gate on status = 'valid' — no new enforcement code needed.
  const invalidatedTickets = await db.query(
    `UPDATE tickets SET status = 'invalidated' WHERE event_id = $1 AND status != 'invalidated' RETURNING id, owner_user_id`,
    [event.id]
  );
  await db.query(`UPDATE resale_listings SET status = 'removed' WHERE event_id = $1 AND status = 'active'`, [event.id]);
  await db.query(`UPDATE orders SET status = 'cancelled' WHERE event_id = $1 AND status = 'pending_payment'`, [event.id]);

  // Every paid order gets a refund request opened on the customer's behalf
  // for its full remaining balance — an admin still has to approve it (the
  // same review queue as any other refund; money never moves without that),
  // but the customer shouldn't have to ask when the organizer caused this.
  const refundableOrders = await db.query(
    `SELECT * FROM orders WHERE event_id = $1 AND status IN ('paid', 'partially_refunded')`,
    [event.id]
  );
  const notifyMap = new Map(); // userId -> refundInitiated
  for (const t of invalidatedTickets) notifyMap.set(t.owner_user_id, false);

  let refundsCreated = 0;
  for (const order of refundableOrders) {
    const remaining = order.total_cents - order.refunded_cents;
    if (remaining <= 0) continue;
    const existing = await db.query(`SELECT id FROM refunds WHERE order_id = $1 AND status = 'requested'`, [order.id]);
    if (existing.length > 0) continue;
    await db.query(
      `INSERT INTO refunds (order_id, requested_by_user_id, amount_cents, reason) VALUES ($1, $2, $3, $4)`,
      [order.id, order.user_id, remaining, `Event cancelled by organizer${reason ? `: ${reason}` : ''}`]
    );
    refundsCreated++;
    notifyMap.set(order.user_id, true);
  }

  for (const [userId, refundInitiated] of notifyMap) {
    await notify(userId, 'event.cancelled', { eventName: event.name, reason, refundInitiated }, ['in_app', 'email']);
  }

  await audit(req.user.sub, 'event.cancelled', 'event', event.id, {
    reason,
    ticketsInvalidated: invalidatedTickets.length,
    refundsCreated,
  });

  res.json({ message: 'Event cancelled', ticketsInvalidated: invalidatedTickets.length, refundsCreated });
});

router.post('/events/:id/postpone', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const event = await getOwnedEventOrFail(req.user.sub, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status === 'cancelled') return res.status(400).json({ error: 'Cannot postpone a cancelled event' });

  const { newStartsAt, reason } = req.body || {};
  const parsed = newStartsAt ? new Date(newStartsAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return res.status(400).json({ error: 'newStartsAt must be a valid date' });
  }

  const oldStartsAt = event.starts_at;
  const updated = await db.one(
    `UPDATE events
     SET starts_at = $1, postponed_at = now(), original_starts_at = COALESCE(original_starts_at, starts_at), postpone_reason = $2
     WHERE id = $3 RETURNING *`,
    [parsed.toISOString(), reason || null, event.id]
  );

  // Only ticket holders with a still-valid ticket need to hear about this —
  // someone whose ticket was already invalidated/refunded has nothing riding
  // on the new date.
  const ticketHolders = await db.query(
    `SELECT DISTINCT owner_user_id FROM tickets WHERE event_id = $1 AND status = 'valid'`,
    [event.id]
  );
  for (const row of ticketHolders) {
    await notify(
      row.owner_user_id,
      'event.postponed',
      { eventName: event.name, oldStartsAt, newStartsAt: updated.starts_at, reason },
      ['in_app', 'email']
    );
  }

  await audit(req.user.sub, 'event.postponed', 'event', event.id, { reason, oldStartsAt, newStartsAt: updated.starts_at });
  res.json({ event: updated, notified: ticketHolders.length });
});

// ===================== EVENT COVER IMAGE =====================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imageStorage.MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!imageStorage.isAllowedMime(file.mimetype)) {
      return cb(Object.assign(new Error('Unsupported image type — use JPEG, PNG, or WebP'), { status: 400 }));
    }
    cb(null, true);
  },
});

// Wraps multer so its errors (wrong type, too large) come back as a clean
// 400 instead of falling through to the generic 500 error handler.
function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large — max 5MB' : err.message;
      return res.status(err.status || 400).json({ error: message });
    }
    next();
  });
}

router.post('/events/:id/image', requireAuth, requireRole('organizer_owner'), handleImageUpload, async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await getOwnedEventOrFail(req.user.sub, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (blockIfSuspended(organizer, res)) return;
  if (!req.file) return res.status(400).json({ error: 'image file is required (multipart field "image")' });

  let saved;
  try {
    saved = imageStorage.saveEventImage(event.id, req.file.buffer, req.file.mimetype);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const previousUrl = event.image_url;
  await db.query('UPDATE events SET image_url = $1 WHERE id = $2', [saved.url, event.id]);
  if (previousUrl) imageStorage.deleteEventImage(previousUrl);

  await audit(req.user.sub, 'event.image_uploaded', 'event', event.id, {});
  res.status(201).json({ imageUrl: saved.url });
});

router.delete('/events/:id/image', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await getOwnedOrganizerOrFail(req.user.sub);
  const event = await getOwnedEventOrFail(req.user.sub, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (blockIfSuspended(organizer, res)) return;
  if (!event.image_url) return res.status(400).json({ error: 'This event has no image to remove' });

  imageStorage.deleteEventImage(event.image_url);
  await db.query('UPDATE events SET image_url = NULL WHERE id = $1', [event.id]);
  await audit(req.user.sub, 'event.image_removed', 'event', event.id, {});
  res.json({ message: 'Image removed' });
});

module.exports = router;
