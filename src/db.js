// src/db.js
// Postgres backend (for Cloud Run + Cloud SQL). Swapped in place of the
// node:sqlite version used for local/Railway deployment — same schema,
// same table/column names, adapted to Postgres syntax and an async pool.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Cloud SQL via the Auth Proxy / Unix socket doesn't need SSL; a direct
  // TCP connection to a public Cloud SQL IP does. Toggle with PGSSL=require.
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

// Runs fn(client) inside a transaction. client.query(sql, params) works the
// same as the top-level query() helper. Commits on success, rolls back and
// rethrows on any error.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (sql, params = []) => client.query(sql, params).then((r) => r.rows),
      one: async (sql, params = []) => (await client.query(sql, params)).rows[0],
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS organizers (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  settlement_method TEXT,
  settlement_account TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  organizer_id INTEGER NOT NULL REFERENCES organizers(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  venue TEXT,
  city TEXT,
  country TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity_total INTEGER NOT NULL,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_sold INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'pending_payment',
  subtotal_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payment_intent_id TEXT UNIQUE,
  reservation_expires_at TIMESTAMPTZ,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== REFUNDS AND DISPUTES =====================
-- Every refund is a request first (customer-initiated) and a decision
-- second (admin approve/reject) — money never moves without a human in the
-- loop, which is the actual "dispute workflow" the go-live checklist asks
-- for. orders.refunded_cents tracks the running total already refunded so
-- concurrent/duplicate approvals can be checked atomically (same pattern as
-- the oversell fix's atomic conditional UPDATE) rather than trusting a
-- point-in-time SELECT.
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested', -- requested | approved_processing | succeeded | failed | rejected | manual_required
  provider TEXT,
  provider_refund_id TEXT,
  idempotency_key TEXT UNIQUE,
  decided_by_user_id INTEGER REFERENCES users(id),
  decision_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- ===================== ACCOUNT ACCESS & SECURITY =====================
-- Sessions are tracked explicitly (rather than trusting a bare stateless
-- JWT) so a session can actually be revoked before its 7-day expiry —
-- logout, "sign out other devices", and a forced sign-out after a password
-- reset all depend on a row existing here to flip revoked_at on.
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Tokens are never stored raw — only their sha256 hash — so a leaked
-- database dump can't be used to verify anyone's email or reset a password.
CREATE TABLE IF NOT EXISTS email_verifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- One-time recovery codes for a user who's enabled TOTP MFA and lost their
-- authenticator device. Only hashes are stored; the plaintext codes are
-- shown exactly once, at the moment MFA is enabled.
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resale_listings (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  seller_user_id INTEGER NOT NULL REFERENCES users(id),
  price_cents INTEGER NOT NULL,
  price_cap_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resale_orders (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES resale_listings(id),
  buyer_user_id INTEGER NOT NULL REFERENCES users(id),
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_intent_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  seat_ids TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  resale_order_id INTEGER REFERENCES resale_orders(id),
  provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT UNIQUE NOT NULL,
  raw_webhook_payload TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'valid',
  qr_jti TEXT UNIQUE NOT NULL,
  qr_token TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_transfers (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT 'transfer',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_seats (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  section_name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'b',
  row_label TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  ticket_id INTEGER REFERENCES tickets(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(event_id, section_name, row_label, seat_number)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS saved_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, event_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  meta TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fraud_signals (
  id SERIAL PRIMARY KEY,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  user_id INTEGER REFERENCES users(id),
  event_id INTEGER REFERENCES events(id),
  meta TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now()
);
  `);

  // CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists
  // from a prior deploy — it does NOT retroactively add new columns. Anything
  // added to an existing table after the first deploy needs its own explicit,
  // idempotent ALTER here so upgrading a live database is always safe to
  // just run again on every boot.
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS postponed_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS original_starts_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS postpone_reason TEXT;`);
}

module.exports = { pool, query, one, withTransaction, migrate };
