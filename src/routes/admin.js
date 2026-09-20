// src/routes/admin.js
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const pii = require('../utils/piiCrypto');

const router = express.Router();
router.use(requireAuth, requireRole('platform_admin'));

router.get('/organizers/pending', async (req, res) => {
  const rows = await db.query(`SELECT * FROM organizers WHERE verification_status = 'pending'`);
  // settlement_account is stored encrypted (utils/piiCrypto.js) — a platform
  // admin reviewing onboarding is the one legitimate place to decrypt it.
  const organizers = rows.map((o) => ({ ...o, settlement_account: pii.decrypt(o.settlement_account) }));
  res.json({ organizers });
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

// ===================== ORGANIZER SUSPENSION =====================
// Distinct from reject: reject is a pre-approval decision on an organizer
// who was never live. Suspension pauses an already-approved organizer —
// e.g. a dispute pattern or a fraud signal worth investigating — without
// deleting their account, their history, or unpublishing events already on
// sale (an admin can still cancel a specific event separately if that's
// warranted). It's also independent of payouts_frozen_at/reason above:
// suspending an organizer does not automatically freeze their payouts, and
// freezing payouts does not suspend them — freeze/unfreeze exists precisely
// for the money-only case, so the two are decided separately.

router.get('/organizers/suspended', async (req, res) => {
  const rows = await db.query(`SELECT * FROM organizers WHERE verification_status = 'suspended'`);
  const organizers = rows.map((o) => ({ ...o, settlement_account: pii.decrypt(o.settlement_account) }));
  res.json({ organizers });
});

router.post('/organizers/:id/suspend', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  if (org.verification_status !== 'approved') {
    return res.status(409).json({ error: `Only an approved organizer can be suspended — current status: ${org.verification_status}` });
  }
  await db.query(
    `UPDATE organizers SET verification_status = 'suspended', suspended_at = now(), suspension_reason = $1 WHERE id = $2`,
    [req.body?.reason || null, org.id]
  );
  await audit(req.user.sub, 'organizer.suspended', 'organizer', org.id, { reason: req.body?.reason });
  await notify(org.owner_user_id, 'organizer.suspended', { organizerId: org.id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Organizer suspended' });
});

router.post('/organizers/:id/reactivate', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  if (org.verification_status !== 'suspended') {
    return res.status(409).json({ error: `Only a suspended organizer can be reactivated — current status: ${org.verification_status}` });
  }
  await db.query(
    `UPDATE organizers SET verification_status = 'approved', suspended_at = NULL, suspension_reason = NULL WHERE id = $1`,
    [org.id]
  );
  await audit(req.user.sub, 'organizer.reactivated', 'organizer', org.id, {});
  await notify(org.owner_user_id, 'organizer.reactivated', { organizerId: org.id }, ['in_app', 'email']);
  res.json({ message: 'Organizer reactivated' });
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

// ===================== REFUNDS / DISPUTES REVIEW QUEUE =====================
const { processRefundWithProvider } = require('./refunds');

router.get('/refunds/pending', async (req, res) => {
  const rows = await db.query(
    `SELECT r.*, o.total_cents AS order_total_cents, o.currency, o.refunded_cents AS order_refunded_cents,
            u.name AS customer_name, u.email AS customer_email
     FROM refunds r
     JOIN orders o ON o.id = r.order_id
     JOIN users u ON u.id = r.requested_by_user_id
     WHERE r.status = 'requested'
     ORDER BY r.created_at ASC`
  );
  res.json({ refunds: rows });
});

router.post('/refunds/:id/reject', async (req, res) => {
  const refund = await db.one('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
  if (!refund) return res.status(404).json({ error: 'Refund request not found' });
  if (refund.status !== 'requested') {
    return res.status(409).json({ error: `This refund request is no longer pending — current status: ${refund.status}` });
  }

  await db.query(
    `UPDATE refunds SET status = 'rejected', decided_by_user_id = $1, decision_reason = $2, decided_at = now() WHERE id = $3`,
    [req.user.sub, req.body?.reason || null, refund.id]
  );
  await audit(req.user.sub, 'refund.rejected', 'refund', refund.id, { reason: req.body?.reason });
  await notify(refund.requested_by_user_id, 'refund.rejected', { orderId: refund.order_id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Refund request rejected' });
});

router.post('/refunds/:id/approve', async (req, res) => {
  const refund = await db.one('SELECT * FROM refunds WHERE id = $1', [req.params.id]);
  if (!refund) return res.status(404).json({ error: 'Refund request not found' });
  if (refund.status !== 'requested') {
    return res.status(409).json({ error: `This refund request is no longer pending — current status: ${refund.status}` });
  }

  // Atomic conditional UPDATE — same principle as the oversell fix: the
  // running total (refunded_cents) is checked AND incremented in one
  // statement, inside a transaction, so two admins approving two different
  // pending requests on the same order at the same instant can't jointly
  // refund more than the order actually cost. 0 rows back means someone
  // else's approval (or a race) already used up the remaining balance.
  let order;
  try {
    order = await db.withTransaction(async (tx) => {
      const claimed = await tx.query(
        `UPDATE orders SET refunded_cents = refunded_cents + $1
         WHERE id = $2 AND refunded_cents + $1 <= total_cents
         RETURNING *`,
        [refund.amount_cents, refund.order_id]
      );
      if (claimed.length === 0) {
        throw Object.assign(
          new Error('Approving this would exceed the order total — another refund may have just been approved for it'),
          { status: 409 }
        );
      }
      await tx.query(`UPDATE refunds SET status = 'approved_processing', decided_by_user_id = $1, decided_at = now() WHERE id = $2`, [req.user.sub, refund.id]);
      return claimed[0];
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const isFullRefund = order.refunded_cents >= order.total_cents;

  const result = await processRefundWithProvider({ order, refund });

  await db.withTransaction(async (tx) => {
    await tx.query(
      `UPDATE refunds SET status = $1, provider = $2, provider_refund_id = $3, completed_at = $4 WHERE id = $5`,
      [
        result.status === 'succeeded' ? 'succeeded' : result.status === 'manual_required' ? 'manual_required' : 'failed',
        result.provider,
        result.providerRefundId,
        result.status === 'succeeded' ? new Date().toISOString() : null,
        refund.id,
      ]
    );

    if (result.status === 'succeeded' && isFullRefund) {
      const items = await tx.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
      await tx.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]);
      const ticketRows = await tx.query('SELECT id FROM tickets WHERE order_id = $1', [order.id]);
      for (const t of ticketRows) {
        await tx.query(`UPDATE tickets SET status = 'invalidated' WHERE id = $1`, [t.id]);
      }
    } else if (result.status === 'succeeded' && !isFullRefund) {
      await tx.query(`UPDATE orders SET status = 'partially_refunded' WHERE id = $1`, [order.id]);
    } else if (result.status === 'failed') {
      // Refund failed at the provider after we already committed to it —
      // roll back the running total we reserved so it doesn't permanently
      // eat into the order's refundable balance.
      await tx.query(`UPDATE orders SET refunded_cents = refunded_cents - $1 WHERE id = $2`, [refund.amount_cents, order.id]);
    }
    // manual_required: refunded_cents stays claimed (money is committed to
    // go out, just via a manual channel) and order status is left as-is
    // until the manual M-Pesa reversal is confirmed and this is revisited.
  });

  await audit(req.user.sub, 'refund.approved', 'refund', refund.id, { amountCents: refund.amount_cents, result: result.status, provider: result.provider });

  if (result.status === 'succeeded') {
    await notify(refund.requested_by_user_id, 'refund.approved', {
      orderId: order.id,
      amountFormatted: `${(refund.amount_cents / 100).toFixed(2)} ${order.currency}`,
      fullRefund: isFullRefund,
    }, ['in_app', 'email']);
  } else if (result.status === 'manual_required') {
    await notify(refund.requested_by_user_id, 'refund.manual_required', { orderId: order.id }, ['in_app', 'email']);
  } else {
    await notify(refund.requested_by_user_id, 'refund.failed', { orderId: order.id }, ['in_app', 'email']);
  }

  res.json({ message: `Refund ${result.status}`, refundStatus: result.status });
});

// ===================== ORGANIZER PAYOUTS REVIEW QUEUE =====================
const { processPayoutWithProvider } = require('./payouts');

router.post('/organizers/:id/freeze-payouts', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  await db.query(
    `UPDATE organizers SET payouts_frozen_at = now(), payouts_frozen_reason = $1 WHERE id = $2`,
    [req.body?.reason || null, org.id]
  );
  await audit(req.user.sub, 'organizer.payouts_frozen', 'organizer', org.id, { reason: req.body?.reason });
  await notify(org.owner_user_id, 'organizer.payouts_frozen', { reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Payouts frozen for this organizer' });
});

router.post('/organizers/:id/unfreeze-payouts', async (req, res) => {
  const org = await db.one('SELECT * FROM organizers WHERE id = $1', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Organizer not found' });
  await db.query(`UPDATE organizers SET payouts_frozen_at = NULL, payouts_frozen_reason = NULL WHERE id = $1`, [org.id]);
  await audit(req.user.sub, 'organizer.payouts_unfrozen', 'organizer', org.id, {});
  await notify(org.owner_user_id, 'organizer.payouts_unfrozen', {}, ['in_app', 'email']);
  res.json({ message: 'Payouts unfrozen for this organizer' });
});

router.get('/payouts/pending', async (req, res) => {
  const rows = await db.query(
    `SELECT p.*, o.name AS organizer_name, o.payouts_frozen_at, e.name AS event_name, e.currency
     FROM payouts p
     JOIN organizers o ON o.id = p.organizer_id
     JOIN events e ON e.id = p.event_id
     WHERE p.status = 'requested'
     ORDER BY p.created_at ASC`
  );
  res.json({ payouts: rows });
});

router.post('/payouts/:id/reject', async (req, res) => {
  const payout = await db.one('SELECT * FROM payouts WHERE id = $1', [req.params.id]);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  if (payout.status !== 'requested') {
    return res.status(409).json({ error: `This payout is no longer pending — current status: ${payout.status}` });
  }
  await db.query(
    `UPDATE payouts SET status = 'rejected', decided_by_user_id = $1, decision_reason = $2, decided_at = now() WHERE id = $3`,
    [req.user.sub, req.body?.reason || null, payout.id]
  );
  await audit(req.user.sub, 'payout.rejected', 'payout', payout.id, { reason: req.body?.reason });
  const organizer = await db.one('SELECT * FROM organizers WHERE id = $1', [payout.organizer_id]);
  await notify(organizer.owner_user_id, 'payout.rejected', { payoutId: payout.id, reason: req.body?.reason }, ['in_app', 'email']);
  res.json({ message: 'Payout rejected' });
});

router.post('/payouts/:id/approve', async (req, res) => {
  const payout = await db.one('SELECT * FROM payouts WHERE id = $1', [req.params.id]);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  if (payout.status !== 'requested') {
    return res.status(409).json({ error: `This payout is no longer pending — current status: ${payout.status}` });
  }

  const organizer = await db.one('SELECT * FROM organizers WHERE id = $1', [payout.organizer_id]);
  if (organizer.payouts_frozen_at) {
    return res.status(409).json({
      error: `Payouts are frozen for this organizer${organizer.payouts_frozen_reason ? `: ${organizer.payouts_frozen_reason}` : ''} — unfreeze before approving`,
    });
  }

  // Atomic claim — same principle as refund approval: only one admin's
  // approval of this specific payout can win the transition out of
  // 'requested', so a double-click or two admins racing can't both
  // dispatch the same payment.
  const claimed = await db.query(
    `UPDATE payouts SET status = 'approved_processing', decided_by_user_id = $1, decided_at = now() WHERE id = $2 AND status = 'requested' RETURNING *`,
    [req.user.sub, payout.id]
  );
  if (claimed.length === 0) {
    return res.status(409).json({ error: 'This payout was just decided by someone else' });
  }

  const result = await processPayoutWithProvider({ organizer, payout: claimed[0] });

  if (result.status !== 'processing') {
    await db.query(
      `UPDATE payouts SET status = $1, provider = $2, provider_payout_id = $3, completed_at = $4 WHERE id = $5`,
      [result.status, result.provider, result.providerPayoutId, result.status === 'succeeded' ? new Date().toISOString() : null, payout.id]
    );
  } else {
    await db.query(`UPDATE payouts SET provider = $1, provider_payout_id = $2 WHERE id = $3`, [result.provider, result.providerPayoutId, payout.id]);
  }

  await audit(req.user.sub, 'payout.approved', 'payout', payout.id, {
    amountCents: payout.amount_cents,
    result: result.status,
    provider: result.provider,
  });

  if (result.status === 'manual_required') {
    await notify(organizer.owner_user_id, 'payout.manual_required', { payoutId: payout.id, amountCents: payout.amount_cents }, ['in_app', 'email']);
  } else if (result.status === 'failed') {
    await notify(organizer.owner_user_id, 'payout.failed', { payoutId: payout.id }, ['in_app', 'email']);
  } else if (result.status === 'processing') {
    await notify(organizer.owner_user_id, 'payout.processing', { payoutId: payout.id, amountCents: payout.amount_cents }, ['in_app', 'email']);
  }

  res.json({ message: `Payout ${result.status}`, payoutStatus: result.status });
});

module.exports = router;
