// src/routes/orders.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const { checkOrderVelocity } = require('../utils/fraud');
const { checkoutLimiter } = require('../security');
const { signTicketToken, ticketQrDataUrl } = require('../utils/qrTicket');
const {
  createPaymentIntent,
  verifyWebhookSignature,
  simulateAsyncCallback,
} = require('../utils/mockPaymentProvider');
const mpesa = require('../utils/mpesaProvider');

const router = express.Router();

const FEE_RATE = 0.08;
const TAX_RATE = 0.02;
const RESERVATION_MINUTES = 10;

async function validateAndResolveItems(eventId, items) {
  let subtotalCents = 0;
  const resolvedItems = [];
  for (const item of items) {
    const tt = await db.one('SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL', [item.ticketTypeId, eventId]);
    if (!tt) throw Object.assign(new Error(`Ticket type ${item.ticketTypeId} not found on this event`), { status: 404 });

    if (Array.isArray(item.seatIds) && item.seatIds.length > 0) {
      const placeholders = item.seatIds.map((_, i) => `$${i + 3}`).join(',');
      const seats = await db.query(
        `SELECT * FROM event_seats WHERE id IN (${placeholders}) AND event_id = $1 AND ticket_type_id = $2`,
        [eventId, tt.id, ...item.seatIds]
      );
      if (seats.length !== item.seatIds.length) {
        throw Object.assign(new Error('One or more selected seats were not found on this ticket type'), { status: 404 });
      }
      const taken = seats.filter((s) => s.status !== 'available');
      if (taken.length > 0) {
        throw Object.assign(new Error(`Seat ${taken[0].row_label}${taken[0].seat_number} is no longer available`), { status: 409 });
      }
      subtotalCents += tt.price_cents * seats.length;
      resolvedItems.push({ ticketType: tt, quantity: seats.length, seatIds: item.seatIds });
    } else {
      const available = tt.quantity_total - tt.quantity_reserved - tt.quantity_sold;
      if (!item.quantity || item.quantity < 1 || item.quantity > available) {
        throw Object.assign(new Error(`Only ${available} left of "${tt.name}"`), { status: 409 });
      }
      subtotalCents += tt.price_cents * item.quantity;
      resolvedItems.push({ ticketType: tt, quantity: item.quantity, seatIds: null });
    }
  }
  return { subtotalCents, resolvedItems };
}

async function reserveAndCreateOrder({ userId, eventId, currency, subtotalCents, feeCents, taxCents, totalCents, paymentIntentId, resolvedItems }) {
  const reservationExpiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();
  return db.withTransaction(async (tx) => {
    const created = await tx.one(
      `INSERT INTO orders (user_id, event_id, status, subtotal_cents, fee_cents, tax_cents, total_cents, currency, payment_intent_id, reservation_expires_at)
       VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, eventId, subtotalCents, feeCents, taxCents, totalCents, currency, paymentIntentId, reservationExpiresAt]
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
}

router.post('/', requireAuth, checkoutLimiter, async (req, res) => {
  const { eventId, items, paymentMethod, simulateOutcome, phone } = req.body;
  if (!eventId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'eventId and at least one item are required' });
  }

  const event = await db.one(`SELECT * FROM events WHERE id = $1 AND status = 'published'`, [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found or not published' });

  let subtotalCents, resolvedItems;
  try {
    ({ subtotalCents, resolvedItems } = await validateAndResolveItems(eventId, items));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const feeCents = Math.round(subtotalCents * FEE_RATE);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents + feeCents + taxCents;

  const useMpesa = paymentMethod === 'mpesa' && mpesa.isConfigured() && event.currency === 'KES';

  if (useMpesa) {
    // Real Daraja STK Push: this must succeed BEFORE we reserve any inventory
    // or create an order — if the phone number is bad or Safaricom's API is
    // down, the customer should see that immediately, not end up holding a
    // reservation for a payment that was never actually requested.
    if (!phone) return res.status(400).json({ error: 'phone is required for M-Pesa payments' });

    let stk;
    try {
      stk = await mpesa.initiateSTKPush({
        phone,
        amountCents: totalCents,
        accountReference: `AFT-${eventId}`,
        transactionDesc: event.name,
      });
    } catch (err) {
      return res.status(502).json({ error: `M-Pesa request failed: ${err.message}` });
    }

    let order;
    try {
      order = await reserveAndCreateOrder({
        userId: req.user.sub, eventId, currency: event.currency,
        subtotalCents, feeCents, taxCents, totalCents,
        paymentIntentId: stk.checkoutRequestId, resolvedItems,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Checkout failed after STK push was sent — contact support with this reference: ' + stk.checkoutRequestId, detail: err.message });
    }

    await audit(req.user.sub, 'order.created', 'order', order.id, { totalCents, paymentIntentId: stk.checkoutRequestId, provider: 'mpesa_daraja' });
    await checkOrderVelocity(req.user.sub, eventId);

    return res.status(201).json({
      order,
      paymentIntentId: stk.checkoutRequestId,
      provider: 'mpesa_daraja',
      message: stk.customerMessage || 'Check your phone and enter your M-Pesa PIN to complete payment.',
    });
  }

  // Mock provider path (used whenever M-Pesa isn't configured/applicable, or
  // for any other payment method) — simulates the same async webhook pattern
  // a real gateway integration uses, so the checkout flow is exercisable
  // without live credentials.
  const { paymentIntentId, provider } = createPaymentIntent({
    amountCents: totalCents,
    currency: event.currency,
    method: paymentMethod || 'card',
  });

  let order;
  try {
    order = await reserveAndCreateOrder({
      userId: req.user.sub, eventId, currency: event.currency,
      subtotalCents, feeCents, taxCents, totalCents, paymentIntentId, resolvedItems,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Checkout failed', detail: err.message });
  }

  await audit(req.user.sub, 'order.created', 'order', order.id, { totalCents, paymentIntentId });
  await checkOrderVelocity(req.user.sub, eventId);

  simulateAsyncCallback({ paymentIntentId, outcome: simulateOutcome === 'failed' ? 'failed' : 'succeeded' }, (body, signature) => {
    processMockWebhookPayload(body, signature).catch((err) => console.error('webhook processing failed', err));
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
    const result = await processMockWebhookPayload(rawBody, signature);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Real Safaricom Daraja callback. The URL itself carries a shared-secret path
// segment (rather than a signed-body scheme) because Daraja's STK callback
// mechanism doesn't support custom auth headers — this is the standard
// pattern for securing a webhook URL you can't attach headers to.
router.post('/webhook/mpesa/:secret', async (req, res) => {
  if (!mpesa.verifyCallbackSecret(req.params.secret)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Safaricom expects a fast, simple ack. We always acknowledge once the
  // secret checks out, and log (rather than surface) any internal
  // processing error, so a bug on our side can't cause Daraja to retry the
  // same callback indefinitely.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const result = mpesa.parseCallback(req.body);
    const order = await db.one('SELECT * FROM orders WHERE payment_intent_id = $1', [result.checkoutRequestId]);
    if (!order) {
      console.error('M-Pesa callback for unknown CheckoutRequestID', result.checkoutRequestId);
      return;
    }
    if (order.status !== 'pending_payment') {
      return; // already finalized — Safaricom occasionally retries the same callback
    }
    await finalizeOrderPayment(order, {
      status: result.success ? 'succeeded' : 'failed',
      provider: 'mpesa_daraja',
      idempotencyKey: `mpesa_${result.checkoutRequestId}`,
      rawPayload: JSON.stringify(req.body),
      meta: { mpesaReceiptNumber: result.mpesaReceiptNumber, resultDesc: result.resultDesc },
    });
  } catch (err) {
    console.error('M-Pesa callback processing failed:', err.message);
  }
});

async function processMockWebhookPayload(rawBody, signature) {
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

  await finalizeOrderPayment(order, { status, provider: 'mock_provider', idempotencyKey, rawPayload: rawBody });
  return { alreadyProcessed: false, orderId: order.id, status };
}

// Shared by both the mock provider's webhook and the real M-Pesa callback —
// the actual business logic (mint tickets, release/consume inventory, notify,
// audit) is identical regardless of which provider settled the payment.
async function finalizeOrderPayment(order, { status, provider, idempotencyKey, rawPayload }) {
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (order_id, provider, amount_cents, status, idempotency_key, raw_webhook_payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [order.id, provider, order.total_cents, status, idempotencyKey, rawPayload]
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
    await audit(order.user_id, 'payment.succeeded', 'order', order.id, { provider });
  } else if (status === 'failed') {
    await notify(order.user_id, 'payment.failed', { orderId: order.id }, ['in_app', 'email']);
    await audit(order.user_id, 'payment.failed', 'order', order.id, { provider });
  }
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
