// src/utils/stripeProvider.js
// Real Stripe integration via the official SDK — PaymentIntents API, not a
// mock. Unlike M-Pesa's STK Push (which actively pushes a prompt to a real
// phone the moment we call it), creating a Stripe PaymentIntent has no side
// effects on its own — nothing is charged until the customer's card is
// confirmed client-side — so it's safe to create the order/reservation
// first and the PaymentIntent second, the opposite order from the M-Pesa flow.
let stripeClient = null;
function getClient() {
  if (!stripeClient) {
    // eslint-disable-next-line global-require
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

// Stripe requires the smallest currency unit already (cents for USD, pence
// for GBP) for most currencies, but zero-decimal currencies (e.g. JPY, KES
// is NOT zero-decimal so this doesn't affect our KES events) must be passed
// as a whole number with no multiplier. Our amounts are already stored in
// "cents" for every currency in this app's own schema, which matches what
// Stripe wants for every currency we currently support (USD, GBP, EUR, CAD,
// ZAR, NGN, GHS are all 2-decimal); listed here for the one exception if a
// zero-decimal currency is ever added.
const ZERO_DECIMAL_CURRENCIES = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function toStripeAmount(amountCents, currency) {
  const lower = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(lower)) {
    return Math.round(amountCents / 100); // our "cents" would otherwise double-divide a currency Stripe treats as whole units
  }
  return amountCents;
}

async function createPaymentIntent({ amountCents, currency, metadata }) {
  const stripe = getClient();
  const intent = await stripe.paymentIntents.create({
    amount: toStripeAmount(amountCents, currency),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata,
  });
  return { id: intent.id, clientSecret: intent.client_secret };
}

// Stripe's own SDK verifies the webhook's HMAC signature locally — no
// network call needed, so this can be (and was) fully tested without any
// live Stripe credentials. Throws if the signature doesn't match or the
// payload was tampered with.
function constructWebhookEvent(rawBody, signature) {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// Real refund via Stripe's Refunds API. idempotencyKey is passed as Stripe's
// own request-level idempotency key (a distinct mechanism from our
// application-level idempotency_key column) so a retried request after a
// network timeout can never create two refunds for the same intent.
async function createRefund({ paymentIntentId, amountCents, currency, idempotencyKey }) {
  const stripe = getClient();
  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: toStripeAmount(amountCents, currency),
    },
    { idempotencyKey }
  );
  return { id: refund.id, status: refund.status };
}

module.exports = { isConfigured, createPaymentIntent, constructWebhookEvent, createRefund };
