// src/routes/resale.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const { signTicketToken } = require('../utils/qrTicket');
const {
  createPaymentIntent,
  verifyWebhookSignature,
  simulateAsyncCallback,
} = require('../utils/mockPaymentProvider');

const router = express.Router();
const RESALE_FEE_RATE = 0.10;

router.post('/list', requireAuth, async (req, res) => {
  const { ticketId, price } = req.body;
  if (!ticketId || !price) return res.status(400).json({ error: 'ticketId and price are required' });

  const ticket = await db.one('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (!ticket || ticket.owner_user_id !== req.user.sub) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  if (ticket.status !== 'valid') {
    return res.status(409).json({ error: `This ticket can't be listed — current status: ${ticket.status}` });
  }

  const ticketType = await db.one('SELECT * FROM ticket_types WHERE id = $1', [ticket.ticket_type_id]);
  const priceCents = Math.round(price * 100);
  const capCents = ticketType.price_cents;

  if (priceCents > capCents) {
    return res.status(400).json({ error: `Resale price can't exceed face value of ${(capCents / 100).toFixed(2)}` });
  }

  let listing;
  try {
    listing = await db.withTransaction(async (tx) => {
      const created = await tx.one(
        `INSERT INTO resale_listings (ticket_id, event_id, ticket_type_id, seller_user_id, price_cents, price_cap_cents)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [ticket.id, ticket.event_id, ticket.ticket_type_id, req.user.sub, priceCents, capCents]
      );
      await tx.query(`UPDATE tickets SET status = 'listed' WHERE id = $1`, [ticket.id]);
      return created;
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not create listing', detail: err.message });
  }
  await audit(req.user.sub, 'resale.listed', 'resale_listing', listing.id, { ticketId, priceCents });
  res.status(201).json({ listing });
});

router.get('/listings', async (req, res) => {
  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId query param is required' });
  const rows = await db.query(
    `SELECT rl.id, rl.price_cents, rl.price_cap_cents, rl.created_at, tt.name AS ticket_type_name, e.currency
     FROM resale_listings rl
     JOIN ticket_types tt ON tt.id = rl.ticket_type_id
     JOIN events e ON e.id = rl.event_id
     WHERE rl.event_id = $1 AND rl.status = 'active'
     ORDER BY rl.price_cents ASC`,
    [eventId]
  );
  res.json({ listings: rows });
});

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT rl.*, tt.name AS ticket_type_name, e.name AS event_name
     FROM resale_listings rl
     JOIN ticket_types tt ON tt.id = rl.ticket_type_id
     JOIN events e ON e.id = rl.event_id
     WHERE rl.seller_user_id = $1 ORDER BY rl.created_at DESC`,
    [req.user.sub]
  );
  res.json({ listings: rows });
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const listing = await db.one('SELECT * FROM resale_listings WHERE id = $1', [req.params.id]);
  if (!listing || listing.seller_user_id !== req.user.sub) return res.status(404).json({ error: 'Listing not found' });
  if (listing.status !== 'active') return res.status(409).json({ error: `Listing is already ${listing.status}` });

  try {
    await db.withTransaction(async (tx) => {
      await tx.query(`UPDATE resale_listings SET status = 'cancelled' WHERE id = $1`, [listing.id]);
      await tx.query(`UPDATE tickets SET status = 'valid' WHERE id = $1`, [listing.ticket_id]);
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not cancel listing', detail: err.message });
  }
  await audit(req.user.sub, 'resale.cancelled', 'resale_listing', listing.id, {});
  res.json({ message: 'Listing cancelled' });
});

router.post('/:id/buy', requireAuth, async (req, res) => {
  const listing = await db.one('SELECT * FROM resale_listings WHERE id = $1', [req.params.id]);
  if (!listing || listing.status !== 'active') {
    return res.status(404).json({ error: 'Listing not found or no longer available' });
  }
  if (listing.seller_user_id === req.user.sub) {
    return res.status(400).json({ error: 'You cannot buy your own listing' });
  }
  const event = await db.one('SELECT * FROM events WHERE id = $1', [listing.event_id]);

  const feeCents = Math.round(listing.price_cents * RESALE_FEE_RATE);
  const totalCents = listing.price_cents + feeCents;

  const { paymentIntentId, provider } = createPaymentIntent({
    amountCents: totalCents,
    currency: event.currency,
    method: req.body.paymentMethod || 'card',
  });

  const resaleOrder = await db.one(
    `INSERT INTO resale_orders (listing_id, buyer_user_id, price_cents, fee_cents, total_cents, currency, payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [listing.id, req.user.sub, listing.price_cents, feeCents, totalCents, event.currency, paymentIntentId]
  );

  await audit(req.user.sub, 'resale.purchase_initiated', 'resale_order', resaleOrder.id, { listingId: listing.id, totalCents });

  simulateAsyncCallback(
    { paymentIntentId, outcome: req.body.simulateOutcome === 'failed' ? 'failed' : 'succeeded' },
    (body, signature) => processResaleWebhookPayload(body, signature).catch((err) => console.error('resale webhook failed', err))
  );

  res.status(201).json({
    resaleOrder,
    paymentIntentId,
    provider,
    message: `Payment is processing via ${provider}. Poll GET /api/resale/orders/${resaleOrder.id}.`,
  });
});

router.post('/webhook/payments', async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-afrotickets-signature'];
  try {
    const result = await processResaleWebhookPayload(rawBody, signature);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function processResaleWebhookPayload(rawBody, signature) {
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw new Error('Invalid webhook signature');
  }
  const payload = JSON.parse(rawBody);
  const { paymentIntentId, status, idempotencyKey } = payload;

  const already = await db.one('SELECT * FROM payments WHERE idempotency_key = $1', [idempotencyKey]);
  if (already) return { alreadyProcessed: true, status: already.status };

  const resaleOrder = await db.one('SELECT * FROM resale_orders WHERE payment_intent_id = $1', [paymentIntentId]);
  if (!resaleOrder) throw new Error('Unknown payment intent');
  const listing = await db.one('SELECT * FROM resale_listings WHERE id = $1', [resaleOrder.listing_id]);

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (resale_order_id, provider, amount_cents, status, idempotency_key, raw_webhook_payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [resaleOrder.id, 'mock_provider', resaleOrder.total_cents, status, idempotencyKey, rawBody]
    );

    if (status === 'succeeded' && resaleOrder.status === 'pending_payment') {
      const oldTicket = await tx.one('SELECT * FROM tickets WHERE id = $1', [listing.ticket_id]);
      await tx.query(`UPDATE tickets SET status = 'invalidated' WHERE id = $1`, [oldTicket.id]);

      const { token, jti } = signTicketToken({
        eventId: oldTicket.event_id,
        ticketTypeId: oldTicket.ticket_type_id,
        ownerUserId: resaleOrder.buyer_user_id,
      });
      await tx.query(
        `INSERT INTO tickets (order_id, ticket_type_id, event_id, owner_user_id, qr_jti, qr_token) VALUES ($1, $2, $3, $4, $5, $6)`,
        [oldTicket.order_id, oldTicket.ticket_type_id, oldTicket.event_id, resaleOrder.buyer_user_id, jti, token]
      );

      await tx.query(`UPDATE resale_listings SET status = 'sold' WHERE id = $1`, [listing.id]);
      await tx.query(`UPDATE resale_orders SET status = 'paid' WHERE id = $1`, [resaleOrder.id]);
    } else if (status === 'failed') {
      await tx.query(`UPDATE resale_orders SET status = 'failed' WHERE id = $1`, [resaleOrder.id]);
    }
  });

  if (status === 'succeeded') {
    await audit(resaleOrder.buyer_user_id, 'resale.completed', 'resale_order', resaleOrder.id, { listingId: listing.id });
    await notify(resaleOrder.buyer_user_id, 'resale.ticket_ready', { listingId: listing.id }, ['in_app', 'email']);
    await notify(listing.seller_user_id, 'resale.payout_pending', { listingId: listing.id, amountCents: listing.price_cents }, ['in_app', 'email']);
  } else if (status === 'failed') {
    await notify(resaleOrder.buyer_user_id, 'resale.payment_failed', { listingId: listing.id }, ['in_app']);
  }

  return { alreadyProcessed: false, status };
}

router.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await db.one('SELECT * FROM resale_orders WHERE id = $1', [req.params.id]);
  if (!order || order.buyer_user_id !== req.user.sub) return res.status(404).json({ error: 'Order not found' });
  res.json({ resaleOrder: order });
});

module.exports = router;
