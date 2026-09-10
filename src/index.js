// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const organizerRoutes = require('./routes/organizers');
const orderRoutes = require('./routes/orders');
const ticketRoutes = require('./routes/tickets');
const checkinRoutes = require('./routes/checkin');
const adminRoutes = require('./routes/admin');
const resaleRoutes = require('./routes/resale');

const app = express();

app.use(cors());

// The payment webhooks need the exact raw request bytes to verify their HMAC
// signature, so these exact paths get the raw body parser, and the global
// JSON parser explicitly skips them (chaining both on one path would try to
// read the request stream twice).
const WEBHOOK_PATHS = ['/api/orders/webhook/payments', '/api/resale/webhook/payments'];
WEBHOOK_PATHS.forEach((p) => app.use(p, express.raw({ type: '*/*' })));
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.includes(req.path)) return next();
  return express.json()(req, res, next);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'afrotickets-api' }));

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/organizer', organizerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/resale', resaleRoutes);

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
  app.listen(PORT, () => {
    console.log(`AfroTickets API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start (likely a database connection problem):', err);
  process.exit(1);
});
