// src/routes/refunds.js
// Refunds/disputes: a customer-initiated request that a platform_admin
// reviews and decides — money never moves without a human in the loop.
// Admin decision routes live in admin.js (same pattern as organizer/event
// approve-reject); this file is the customer-facing half: request + list.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');

const router = express.Router();

// Exported so admin.js's approve route can reuse the exact same
// provider-dispatch logic — one refund decision path, not two.
async function processRefundWithProvider({ order, refund }) {
  const idempotencyKey = `refund_${refund.id}`;
  const mockProvider = require('../utils/mockPaymentProvider');
  const stripeProvider = require('../utils/stripeProvider');

  // Figure out which provider actually settled this order's payment —
  // recorded on the `payments` row from the original successful charge.
  const payment = await db.one(
    `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  const provider = payment ? payment.provider : 'mock_provider';

  if (provider === 'mpesa_daraja') {
    // Safaricom's B2C reversal API needs a separate certificate-encrypted
    // security credential, initiator name, and B2C shortcode that this
    // integration was never configured with (only STK Push credentials
    // exist) — faking success here would be dishonest about money actually
    // moving. Flag for manual processing via the Daraja portal instead.
    return { status: 'manual_required', provider: 'mpesa_daraja', providerRefundId: null };
  }

  if (provider === 'stripe' && stripeProvider.isConfigured()) {
    try {
      const result = await stripeProvider.createRefund({
        paymentIntentId: order.payment_intent_id,
        amountCents: refund.amount_cents,
        currency: order.currency,
        idempotencyKey,
      });
      return { status: 'succeeded', provider: 'stripe', providerRefundId: result.id };
    } catch (err) {
      return { status: 'failed', provider: 'stripe', providerRefundId: null, error: err.message };
    }
  }

  // Mock provider — instant success, mirrors the original mock charge flow.
  const result = mockProvider.createRefund({ amountCents: refund.amount_cents });
  return { status: 'succeeded', provider: 'mock_provider', providerRefundId: result.id };
}

router.post('/', requireAuth, async (req, res) => {
  const { orderId, amountCents, reason } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  const order = await db.one('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order || order.user_id !== req.user.sub) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (order.status !== 'paid' && order.status !== 'partially_refunded') {
    return res.status(409).json({ error: `This order can't be refunded — current status: ${order.status}` });
  }

  const remainingCents = order.total_cents - order.refunded_cents;
  if (remainingCents <= 0) {
    return res.status(409).json({ error: 'This order has already been fully refunded' });
  }

  const requestedCents = amountCents != null ? Math.round(amountCents) : remainingCents;
  if (!Number.isInteger(requestedCents) || requestedCents <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer' });
  }
  if (requestedCents > remainingCents) {
    return res.status(400).json({ error: `Requested amount exceeds the refundable balance of ${remainingCents} cents` });
  }

  // Block a duplicate outstanding request rather than letting the customer
  // pile up requests that could jointly exceed the order total — the
  // atomic approval check in admin.js is the real backstop, but this keeps
  // the queue clean.
  const existing = await db.query(
    `SELECT * FROM refunds WHERE order_id = $1 AND status = 'requested'`,
    [order.id]
  );
  if (existing.length > 0) {
    return res.status(409).json({ error: 'A refund request for this order is already pending review' });
  }

  const created = await db.one(
    `INSERT INTO refunds (order_id, requested_by_user_id, amount_cents, reason) VALUES ($1, $2, $3, $4) RETURNING *`,
    [order.id, req.user.sub, requestedCents, reason || null]
  );

  await audit(req.user.sub, 'refund.requested', 'refund', created.id, { orderId: order.id, amountCents: requestedCents });
  await notify(req.user.sub, 'refund.requested', { orderId: order.id }, ['in_app', 'email']);

  res.status(201).json({ refund: created });
});

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT r.*, o.total_cents AS order_total_cents, o.currency FROM refunds r
     JOIN orders o ON o.id = r.order_id
     WHERE o.user_id = $1 ORDER BY r.created_at DESC`,
    [req.user.sub]
  );
  res.json({ refunds: rows });
});

module.exports = router;
module.exports.processRefundWithProvider = processRefundWithProvider;
