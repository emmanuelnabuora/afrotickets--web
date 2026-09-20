// src/routes/payouts.js
// Organizer payouts: like refunds, a payout is always generated as a
// request first (by utils/payoutScheduler.js, once an event has happened)
// and decided second by a platform_admin (see admin.js) — money never
// moves without a human in the loop. This file is the organizer-facing
// half (view their own payout history) plus the actual provider dispatch
// and its result webhook, mirroring how refunds.js holds the dispatch
// logic that admin.js's approve route calls into.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../utils/audit');
const { notify } = require('../utils/notify');
const pii = require('../utils/piiCrypto');
const mpesa = require('../utils/mpesaProvider');

const router = express.Router();

// Exported so admin.js's approve route can reuse the exact same
// provider-dispatch logic — one payout decision path, not two.
async function processPayoutWithProvider({ organizer, payout }) {
  if (organizer.settlement_method === 'mpesa') {
    if (!mpesa.isB2CConfigured()) {
      // B2C requires a separate initiator identity, RSA-encrypted security
      // credential, and shortcode this deployment was never configured
      // with (only STK Push credentials exist, if any) — faking success
      // here would be dishonest about money actually moving. Flag for
      // manual processing instead, same pattern as the refund reversal path.
      return { status: 'manual_required', provider: 'mpesa_b2c', providerPayoutId: null };
    }
    try {
      const settlementPhone = pii.decrypt(organizer.settlement_account);
      const result = await mpesa.initiateB2CPayout({
        phone: settlementPhone,
        amountCents: payout.amount_cents,
        remarks: `AfroTickets payout #${payout.id}`,
        occasion: `event-${payout.event_id}`,
      });
      // B2C is async — this only confirms Safaricom accepted the request,
      // not that funds actually moved. The real outcome arrives later via
      // the ResultURL callback below, which is what finalizes the status.
      return { status: 'processing', provider: 'mpesa_b2c', providerPayoutId: result.conversationId };
    } catch (err) {
      return { status: 'failed', provider: 'mpesa_b2c', providerPayoutId: null, error: err.message };
    }
  }

  // Bank transfer or any other settlement method — no automated
  // disbursement integration exists for these; flag for a human to wire
  // the money manually via the organizer's on-file settlement_account.
  return { status: 'manual_required', provider: organizer.settlement_method || 'unspecified', providerPayoutId: null };
}

router.get('/mine', requireAuth, requireRole('organizer_owner'), async (req, res) => {
  const organizer = await db.one('SELECT * FROM organizers WHERE owner_user_id = $1', [req.user.sub]);
  if (!organizer) return res.json({ payouts: [] });

  const rows = await db.query(
    `SELECT p.*, e.name AS event_name, e.currency, e.starts_at
     FROM payouts p JOIN events e ON e.id = p.event_id
     WHERE p.organizer_id = $1 ORDER BY p.created_at DESC`,
    [organizer.id]
  );
  res.json({ payouts: rows });
});

// Real Safaricom B2C result callback. Like the STK Push callback, the URL
// itself carries a shared-secret path segment since Daraja callbacks can't
// carry a custom auth header.
router.post('/webhook/mpesa-b2c/:secret', async (req, res) => {
  if (!mpesa.verifyCallbackSecret(req.params.secret)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Safaricom expects a fast, simple ack regardless of how our own
  // processing goes, so a bug on our side can't cause endless retries.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const result = mpesa.parseB2CResult(req.body);
    const payout = await db.one(
      `SELECT * FROM payouts WHERE provider_payout_id = $1 AND provider = 'mpesa_b2c'`,
      [result.conversationId]
    );
    if (!payout) {
      console.error('M-Pesa B2C callback for unknown ConversationID', result.conversationId);
      return;
    }
    if (payout.status !== 'approved_processing') {
      return; // already finalized — Safaricom occasionally retries the same callback
    }
    await db.query(
      `UPDATE payouts SET status = $1, provider_payout_id = $2, completed_at = $3 WHERE id = $4`,
      [
        result.success ? 'succeeded' : 'failed',
        result.transactionId || payout.provider_payout_id,
        result.success ? new Date().toISOString() : null,
        payout.id,
      ]
    );
    await audit(null, result.success ? 'payout.succeeded' : 'payout.failed', 'payout', payout.id, {
      resultDesc: result.resultDesc,
    });
    const organizer = await db.one('SELECT * FROM organizers WHERE id = $1', [payout.organizer_id]);
    await notify(
      organizer.owner_user_id,
      result.success ? 'payout.succeeded' : 'payout.failed',
      { payoutId: payout.id, amountCents: payout.amount_cents },
      ['in_app', 'email']
    );
  } catch (err) {
    console.error('M-Pesa B2C callback processing failed:', err.message);
  }
});

module.exports = router;
module.exports.processPayoutWithProvider = processPayoutWithProvider;
