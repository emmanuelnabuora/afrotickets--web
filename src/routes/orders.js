// src/routes/orders.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const { checkOrderVelocity } = require('../utils/fraud');
const { signTicketToken, ticketQrDataUrl } = require('../utils/qrTicket');
const {
  createPaymentIntent,
  verifyWebhookSignature,
  simulateAsyncCallback,
} = require('../utils/mockPaymentProvider');

const router = express.Router();

const FEE_RATE = 0.08;
const TAX_RATE = 0.02;
const RESERVATION_MINUTES = 10;

router.post('/', requireAuth, async (req, res) => {
  const { eventId, items, paymentMethod, simulateOutcome } = req.body;
  if (!eventId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'eventId and at least one item are required' });
  }

  const event = await db.one(`SELECT * FROM events WHERE id = $1 AND status = 'published'`, [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found or not published' });

  let subtotalCents = 0;
  const resolvedItems = [];
  for (const item of items) {
    const tt = await db.one('SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL', [item.ticketTypeId, eventId]);
    if (!tt) return res.status(404).json({ error: `Ticket type ${item.ticketTypeId} not found on this event` });

    if (Array.isArray(item.seatIds) && item.seatIds.length > 0) {
      const placeholders = item.seatIds.map((_, i) => `$${i + 3}`).join(',');
      const seats = await db.query(
        `SELECT * FROM event_seats WHERE id IN (${placeholders}) AND event_id = $1 AND ticket_type_id = $2`,
        [eventId, tt.id, ...item.seatIds]
      );
      if (seats.length !== item.seatIds.length) {
        return res.status(404).json({ error: 'One or more selected seats were not found on this ticket type' });
      }
      const taken = seats.filter((s) => s.status !== 'available');
      if (taken.length > 0) {
        return res.status(409).json({ error: `Seat ${taken[0].row_label}${taken[0].seat_number} is no longer available` });
      }
      subtotalCents += tt.price_cents * seats.length;
      resolvedItems.push({ ticketType: tt, quantity: seats.length, seatIds: item.seatIds });
    } else {
      const available = tt.quantity_total - tt.quantity_reserved - tt.quantity_sold;
      if (!item.quantity || item.quantity < 1 || item.quantity > available) {
        return res.status(409).json({ error: `Only ${available} left of "${tt.name}"` });
      }
      subtotalCents += tt.price_cents * item.quantity;
      resolvedItems.push({ ticketType: tt, quantity: item.quantity, seatIds: null });
    }
  }

  const feeCents = Math.round(subtotalCents * FEE_RATE);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents + feeCents + taxCents;

  const { paymentIntentId, provider } = createPaymentIntent({
    amountCents: totalCents,
    currency: event.currency,
    method: paymentMethod || 'card',
  });

  const reservationExpiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();

  let order;
  try {
    order = await db.withTransaction(async (tx) => {
      const created = await tx.one(
        `INSERT INTO orders (user_id, event_id, status, subtotal_cents, fee_cents, tax_cents, total_cents, currency, payment_intent_id, reservation_expires_at)
         VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [req.user.sub, eventId, subtotalCents, feeCents, taxCents, totalCents, event.currency, paymentIntentId, reservationExpiresAt]
      );
      for (const { ticketType, quantity, seatIds } of resolvedItems) {
        await tx.query(
          `INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price_cents, seat_ids) VALUES ($1, $2, $3, $4, $5)`,
          [created.id, ticketType.id, quantity, ticketType.price_cents, seatIds ? JSON.stringify(seatIds) : null]
        );
        await tx.query('UPDATE ticket_types SET quantity_reserved = quantity_reserved + $1 WHERE id = $2', [quantity, ticketType.id]);
        if (seatIds) {
          for (const seatId of seatIds) {
            await tx.query(`UPDATE event_seats SET status = 'reserved' WHERE id = $1`, [seatId]);
          }
        }
      }
      return created;
    });
  } catch (err) {
    return res.status(500).json({ error: 'Checkout failed', detail: err.message });
  }

  await audit(req.user.sub, 'order.created', 'order', order.id, { totalCents, paymentIntentId });
  await checkOrderVelocity(req.user.sub, eventId);

  simulateAsyncCallback({ paymentIntentId, outcome: simulateOutcome === 'failed' ? 'failed' : 'succeeded' }, (body, signature) => {
    processWebhookPayload(body, signature).catch((err) => console.error('webhook processing failed', err));
  });

  res.status(201).json({
    order,
    paymentIntentId,
    provider,
    message: `Payment is processing via ${provider}. Poll GET /api/orders/${order.id} — it resolves to "paid" or "failed" within a couple of seconds.`,
  });
});

router.post('/webhook/payments', async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-afrotickets-signature'];
  try {
    const result = await processWebhookPayload(rawBody, signature);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function processWebhookPayload(rawBody, signature) {
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw new Error('Invalid webhook signature');
  }
  const payload = JSON.parse(rawBody);
  const { paymentIntentId, status, idempotencyKey } = payload;

  const already = await db.one('SELECT * FROM payments WHERE idempotency_key = $1', [idempotencyKey]);
  if (already) {
    return { alreadyProcessed: true, orderId: already.order_id, status: already.status };
  }

  const order = await db.one('SELECT * FROM orders WHERE payment_intent_id = $1', [paymentIntentId]);
  if (!order) throw new Error('Unknown payment intent');

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (order_id, provider, amount_cents, status, idempotency_key, raw_webhook_payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [order.id, 'mock_provider', order.total_cents, status, idempotencyKey, rawBody]
    );

    const items = await tx.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);

    if (status === 'succeeded' && order.status === 'pending_payment') {
      for (const item of items) {
        await tx.query(
          'UPDATE ticket_types SET quantity_reserved = quantity_reserved - $1, quantity_sold = quantity_sold + $1 WHERE id = $2',
          [item.quantity, item.ticket_type_id]
        );
        const seatIds = item.seat_ids ? JSON.parse(item.seat_ids) : null;
        for (let i = 0; i < item.quantity; i++) {
          const { token, jti } = signTicketToken({
            eventId: order.event_id,
            ticketTypeId: item.ticket_type_id,
            ownerUserId: order.user_id,
          });
          const ticket = await tx.one(
            `INSERT INTO tickets (order_id, ticket_type_id, event_id, owner_user_id, qr_jti, qr_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [order.id, item.ticket_type_id, order.event_id, order.user_id, jti, token]
          );
          if (seatIds && seatIds[i] != null) {
            await tx.query(`UPDATE event_seats SET status = 'sold', ticket_id = $1 WHERE id = $2`, [ticket.id, seatIds[i]]);
          }
        }
      }
      await tx.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
    } else if (status === 'failed') {
      for (const item of items) {
        await tx.query('UPDATE ticket_types SET quantity_reserved = quantity_reserved - $1 WHERE id = $2', [item.quantity, item.ticket_type_id]);
        const seatIds = item.seat_ids ? JSON.parse(item.seat_ids) : null;
        if (seatIds) {
          for (const seatId of seatIds) {
            await tx.query(`UPDATE event_seats SET status = 'available' WHERE id = $1`, [seatId]);
          }
        }
      }
      await tx.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]);
    }
  });

  if (status === 'succeeded') {
    await notify(order.user_id, 'order.paid', { orderId: order.id, totalCents: order.total_cents }, ['in_app', 'email', 'sms']);
    await audit(order.user_id, 'payment.succeeded', 'order', order.id, { paymentIntentId });
  } else if (status === 'failed') {
    await notify(order.user_id, 'payment.failed', { orderId: order.id }, ['in_app', 'email']);
    await audit(order.user_id, 'payment.failed', 'order', order.id, { paymentIntentId });
  }

  return { alreadyProcessed: false, orderId: order.id, status };
}

router.get('/:id', requireAuth, async (req, res) => {
  const order = await db.one('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!order || order.user_id !== req.user.sub) return res.status(404).json({ error: 'Order not found' });

  const items = await db.query(
    `SELECT oi.*, tt.name AS ticket_type_name FROM order_items oi
     JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = $1`,
    [order.id]
  );

  let tickets = [];
  if (order.status === 'paid') {
    const rows = await db.query('SELECT * FROM tickets WHERE order_id = $1', [order.id]);
    tickets = await Promise.all(
      rows.map(async (t) => {
        const seat = await db.one('SELECT section_name, row_label, seat_number FROM event_seats WHERE ticket_id = $1', [t.id]);
        return {
          id: t.id,
          status: t.status,
          qrDataUrl: await ticketQrDataUrl(t.qr_token),
          qrToken: t.qr_token,
          seat: seat ? { section: seat.section_name, row: seat.row_label, number: seat.seat_number } : null,
        };
      })
    );
  }

  res.json({ order, items, tickets });
});

module.exports = router;
