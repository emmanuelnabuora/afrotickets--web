// src/utils/payoutScheduler.js
// Auto-generates payout *requests* — never dispatches money itself. Two
// sweeps, run on the same interval:
//
//   1. Initial payouts: once a published event's starts_at has passed and it
//      has at least one paid/partially_refunded/refunded order, create the
//      'initial' payout row (gross minus the held-back reserve). Cancelled
//      events are skipped — cancellation already opens refund requests for
//      every paid order (see organizers.js), so any gross here is transient.
//   2. Reserve releases: once RESERVE_HOLD_DAYS have passed since the event
//      *and* its initial payout was actually resolved (succeeded or flagged
//      manual_required — i.e. an admin already decided it), release the
//      reserve, net of any refunds that happened during the hold window.
//
// Both sweeps are idempotent via the payouts.UNIQUE(event_id, kind)
// constraint — they can safely re-scan every event on every run without
// ever double-creating a payout, the same idempotency principle as the
// CREATE TABLE IF NOT EXISTS migrations in db.js and the retention sweep
// in dataRetention.js. If a computed amount is <= 0 (no gross ever
// materialized, or refunds during the hold window absorbed the whole
// reserve), the row is inserted already 'succeeded' with amount_cents 0
// rather than left around for an admin to approve nothing.
const db = require('../db');
const { computeEventGrossCents, splitReserve, RESERVE_HOLD_DAYS } = require('./payoutCalculator');
const { audit } = require('./audit');

const SWEEP_INTERVAL_MS = Number(process.env.PAYOUT_SWEEP_INTERVAL_MS) || 60 * 60 * 1000; // hourly

async function generateInitialPayouts() {
  const events = await db.query(
    `SELECT e.* FROM events e
     WHERE e.starts_at <= now()
       AND e.status != 'cancelled'
       AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.event_id = e.id AND p.kind = 'initial')
       AND EXISTS (
         SELECT 1 FROM orders o
         WHERE o.event_id = e.id AND o.status IN ('paid', 'partially_refunded', 'refunded')
       )`
  );

  for (const event of events) {
    const grossCents = await computeEventGrossCents(event.id);
    const { reserveCents, payableCents } = splitReserve(grossCents);

    if (payableCents <= 0) {
      // Every dollar of gross was already refunded away by the time the
      // sweep got to it — nothing for an admin to approve.
      const payout = await db.one(
        `INSERT INTO payouts (organizer_id, event_id, kind, gross_cents, amount_cents, status, completed_at)
         VALUES ($1, $2, 'initial', $3, 0, 'succeeded', now())
         RETURNING *`,
        [event.organizer_id, event.id, grossCents]
      );
      await audit(null, 'payout.auto_zero', 'payout', payout.id, { eventId: event.id, kind: 'initial' });
      continue;
    }

    const payout = await db.one(
      `INSERT INTO payouts (organizer_id, event_id, kind, gross_cents, amount_cents, status)
       VALUES ($1, $2, 'initial', $3, $4, 'requested')
       RETURNING *`,
      [event.organizer_id, event.id, grossCents, payableCents]
    );
    await audit(null, 'payout.requested', 'payout', payout.id, {
      eventId: event.id, kind: 'initial', grossCents, reserveCents, amountCents: payableCents,
    });
  }
}

async function generateReserveReleases() {
  const rows = await db.query(
    `SELECT p.*, e.organizer_id AS event_organizer_id
     FROM payouts p JOIN events e ON e.id = p.event_id
     WHERE p.kind = 'initial'
       AND p.status IN ('succeeded', 'manual_required')
       AND e.starts_at <= now() - ($1 || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM payouts r WHERE r.event_id = p.event_id AND r.kind = 'reserve_release')`,
    [RESERVE_HOLD_DAYS]
  );

  for (const initialPayout of rows) {
    const newGrossCents = await computeEventGrossCents(initialPayout.event_id);
    const releaseCents = Math.max(0, newGrossCents - initialPayout.amount_cents);

    if (releaseCents <= 0) {
      const payout = await db.one(
        `INSERT INTO payouts (organizer_id, event_id, kind, gross_cents, amount_cents, status, completed_at)
         VALUES ($1, $2, 'reserve_release', $3, 0, 'succeeded', now())
         RETURNING *`,
        [initialPayout.organizer_id, initialPayout.event_id, newGrossCents]
      );
      await audit(null, 'payout.auto_zero', 'payout', payout.id, { eventId: initialPayout.event_id, kind: 'reserve_release' });
      continue;
    }

    const payout = await db.one(
      `INSERT INTO payouts (organizer_id, event_id, kind, gross_cents, amount_cents, status)
       VALUES ($1, $2, 'reserve_release', $3, $4, 'requested')
       RETURNING *`,
      [initialPayout.organizer_id, initialPayout.event_id, newGrossCents, releaseCents]
    );
    await audit(null, 'payout.requested', 'payout', payout.id, {
      eventId: initialPayout.event_id, kind: 'reserve_release', grossCents: newGrossCents, amountCents: releaseCents,
    });
  }
}

async function runPayoutSweep() {
  try {
    await generateInitialPayouts();
    await generateReserveReleases();
  } catch (err) {
    console.error('Payout sweep failed:', err);
  }
}

function startPayoutScheduler() {
  runPayoutSweep();
  const handle = setInterval(runPayoutSweep, SWEEP_INTERVAL_MS);
  handle.unref();
  return handle;
}

module.exports = { startPayoutScheduler, runPayoutSweep };
