// src/index.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');
const { generalLimiter, authLimiter } = require('./security');
const { startRetentionSweep } = require('./utils/dataRetention');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const organizerRoutes = require('./routes/organizers');
const orderRoutes = require('./routes/orders');
const ticketRoutes = require('./routes/tickets');
const checkinRoutes = require('./routes/checkin');
const adminRoutes = require('./routes/admin');
const resaleRoutes = require('./routes/resale');
const afroguideRoutes = require('./routes/afroguide');
const savedRoutes = require('./routes/saved');
const notificationRoutes = require('./routes/notifications');
const refundRoutes = require('./routes/refunds');
const payoutRoutes = require('./routes/payouts');
const discoverRoutes = require('./routes/discover');
const { startPayoutScheduler } = require('./utils/payoutScheduler');

const app = express();

// Cloud Run puts every request through its own reverse proxy, so without
// this, every client looks like it's connecting from the same internal IP —
// which would make the rate limiters below useless (everyone shares one
// bucket) or wrong (blocking everyone at once instead of just the abuser).
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(generalLimiter);

// Uploaded event cover images (see utils/imageStorage.js) — served publicly
// so they can be embedded anywhere (a listing card, a frontend on another
// origin). Helmet's default same-origin resource policy would otherwise
// block exactly that, so it's relaxed just for this one static path.
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(path.join(__dirname, '..', 'uploads'))
);

// The payment webhooks need the exact raw request bytes to verify their HMAC
// signature, so these exact paths get the raw body parser, and the global
// JSON parser explicitly skips them (chaining both on one path would try to
// read the request stream twice). A size limit on both bounds memory use
// from a client sending an oversized body.
const WEBHOOK_PATHS = ['/api/orders/webhook/payments', '/api/resale/webhook/payments', '/api/orders/webhook/stripe'];
WEBHOOK_PATHS.forEach((p) => app.use(p, express.raw({ type: '*/*', limit: '100kb' })));
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.includes(req.path)) return next();
  return express.json({ limit: '100kb' })(req, res, next);
});

const { version: APP_VERSION } = require('../package.json');
// Which deployment this is — 'production' unless a staging (or other)
// service explicitly sets APP_ENV. Surfaced on /health and /version so
// hitting the wrong URL (e.g. prod when you meant staging) is obvious from
// the response itself, not just inferred from which hostname you typed.
const APP_ENV = process.env.APP_ENV || 'production';
app.get('/health', (req, res) => res.json({ ok: true, service: 'afrotickets-api', version: APP_VERSION, env: APP_ENV }));
app.get('/version', (req, res) => res.json({ version: APP_VERSION, db: 'postgres', env: APP_ENV }));
// Public, non-secret config the frontend needs to initialize client-side SDKs.
// The Stripe *publishable* key is safe to expose — it's designed to be
// public and can't authorize charges on its own, unlike the secret key.
app.get('/api/config', (req, res) => res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null }));

app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/mfa/verify', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/verify-phone', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/organizer', organizerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/resale', resaleRoutes);
app.use('/api/afroguide', afroguideRoutes);
app.use('/api/saved', savedRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/discover', discoverRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080; // Cloud Run injects PORT=8080

async function start() {
  // Idempotent — safe to run on every boot. Cloud Run can start multiple
  // instances concurrently; CREATE TABLE IF NOT EXISTS makes that a no-op race.
  await db.migrate();
  startRetentionSweep();
  startPayoutScheduler();
  app.listen(PORT, () => {
    console.log(`AfroTickets API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start (likely a database connection problem):', err);
  process.exit(1);
});
