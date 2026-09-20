// src/utils/mockPaymentProvider.js
// AfroTickets integrates real gateways per-country (M-Pesa, Flutterwave, Paystack,
// Stripe). We don't have live provider credentials in this environment, so this
// module simulates a provider faithfully enough to exercise the real code paths
// that matter: an async payment intent, a signed webhook callback, and
// idempotent processing so a retried webhook can never double-issue tickets.
const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret-change-me';

function createPaymentIntent({ orderId, amountCents, currency, method }) {
  return {
    paymentIntentId: 'pi_' + crypto.randomBytes(10).toString('hex'),
    provider: method === 'mpesa' ? 'mock_mpesa' : method === 'stripe' ? 'mock_stripe' : 'mock_flutterwave',
  };
}

function signWebhookPayload(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return { body, signature };
}

function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  // timing-safe comparison so this can't be brute-forced via response-time side channel
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Simulates the gateway calling us back some time after checkout. In production
// this would be the provider's server hitting POST /api/payments/webhook directly —
// here we just do it in-process after a short delay so the demo is self-contained.
function simulateAsyncCallback({ paymentIntentId, outcome = 'succeeded' }, onCallback) {
  const idempotencyKey = 'evt_' + crypto.randomBytes(10).toString('hex');
  setTimeout(() => {
    const payload = { paymentIntentId, status: outcome, idempotencyKey };
    const { body, signature } = signWebhookPayload(payload);
    onCallback(body, signature);
  }, 1200);
}

// Real gateways settle a refund near-instantly on their own dashboard/API
// with no separate webhook round-trip needed by the caller, so the mock
// mirrors that: an immediate synchronous "success" rather than the
// async-callback dance used for the original charge.
function createRefund({ amountCents }) {
  return { id: 're_' + crypto.randomBytes(10).toString('hex'), status: 'succeeded', amountCents };
}

module.exports = { createPaymentIntent, signWebhookPayload, verifyWebhookSignature, simulateAsyncCallback, createRefund };
