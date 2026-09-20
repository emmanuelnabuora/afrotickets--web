// src/utils/payoutCalculator.js
// Computes an event's organizer-payable proceeds. Deliberately based on
// orders.subtotal_cents, not total_cents — fee_cents (the platform's cut)
// and tax_cents are never part of what the organizer is owed. Computed in
// JS rather than in SQL so the rounding is explicit and auditable (cents,
// never floats) rather than buried in a database expression.
const db = require('../db');

const RESERVE_RATE = Number(process.env.PAYOUT_RESERVE_RATE) || 0.10;
const RESERVE_HOLD_DAYS = Number(process.env.PAYOUT_RESERVE_HOLD_DAYS) || 14;

// Gross proceeds for an event as of *right now*: each order's subtotal,
// clawed back proportionally for whatever fraction of that order has been
// refunded. A fully-refunded order contributes 0; an untouched paid order
// contributes its full subtotal. This is recomputed fresh every time it's
// called (at initial-payout time and again at reserve-release time), so a
// refund that happens between those two moments is automatically reflected.
async function computeEventGrossCents(eventId) {
  const orders = await db.query(
    `SELECT subtotal_cents, total_cents, refunded_cents FROM orders
     WHERE event_id = $1 AND status IN ('paid', 'partially_refunded', 'refunded')`,
    [eventId]
  );
  let grossCents = 0;
  for (const o of orders) {
    if (!o.total_cents) continue;
    const refundedFraction = Math.min(1, o.refunded_cents / o.total_cents);
    grossCents += Math.round(o.subtotal_cents * (1 - refundedFraction));
  }
  return grossCents;
}

function splitReserve(grossCents) {
  const reserveCents = Math.round(grossCents * RESERVE_RATE);
  const payableCents = grossCents - reserveCents;
  return { reserveCents, payableCents };
}

module.exports = { computeEventGrossCents, splitReserve, RESERVE_RATE, RESERVE_HOLD_DAYS };
