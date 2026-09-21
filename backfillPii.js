// backfillPii.js
// One-time backfill for utils/piiCrypto.js (shipped v1.13.0): encrypts any
// users.phone / organizers.settlement_account rows that are still stored as
// plaintext (or encrypted under a since-rotated key) because they were
// written before encryption existed, or between then and whenever a real
// PII_ENCRYPTION_KEY was actually set on this deployment.
//
// IMPORTANT — run this with the SAME PII_ENCRYPTION_KEY the app is
// currently running with (i.e. the real production key, once one is set).
// Whatever key is in the environment when this script runs is the key rows
// get encrypted under; if you later rotate PII_ENCRYPTION_KEY, everything
// this backfill just encrypted becomes undecryptable under the new key,
// exactly like any row written by the app itself. Set the real key first,
// THEN run this — not the other way around.
//
// Idempotent and safe to run more than once: each row is checked against
// the CURRENT key with a real AES-GCM auth-tag verification (not just "does
// it look like base64") before deciding whether it needs encrypting, so a
// second run touches zero rows, and running it again after a genuine key
// rotation correctly re-treats old-key ciphertext as needing backfill again
// rather than mistaking it for already-current.
const crypto = require('crypto');
const db = require('./src/db');
const pii = require('./src/utils/piiCrypto');

// Mirrors the constants inside utils/piiCrypto.js — duplicated here (not
// exported from that file) so this script can attempt a real decrypt+verify
// against the CURRENT key without changing that module's public API for a
// one-off backfill's sake.
const RAW_KEY = process.env.PII_ENCRYPTION_KEY || 'dev-pii-key-change-me-in-production';
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest();
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Classifies a stored value into exactly one of:
//   'skip'          — null/empty, nothing to do
//   'current'       — already encrypted under the key we're running with now
//   'plaintext'     — doesn't even have ciphertext's shape (too short, or
//                     not a clean base64 round-trip) — safe to encrypt
//   'undecryptable' — HAS ciphertext's shape (right length, clean base64)
//                     but its auth tag does not verify under the current
//                     key — almost certainly real ciphertext from a
//                     DIFFERENT key (an earlier rotation), not plaintext.
//
// The 'undecryptable' case matters: naively treating "doesn't verify under
// the current key" as "must be plaintext" and calling encrypt() on it would
// take that old ciphertext BLOB and wrap it as a new "encrypted" value —
// silently double-wrapping it rather than recovering the real plaintext,
// which then becomes unrecoverable once the old key is no longer available.
// This backfill's job is pre-v1.13.0 PLAINTEXT rows specifically, so an
// 'undecryptable' row is left untouched and reported for manual review
// rather than guessed at.
function classify(value) {
  if (value === null || value === undefined || value === '') return 'skip';
  const raw = Buffer.from(value, 'base64');
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH || raw.toString('base64') !== value) {
    return 'plaintext'; // doesn't even have the right shape to be our ciphertext format
  }
  try {
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(authTag);
    decipher.update(encrypted);
    decipher.final(); // throws on auth-tag mismatch — the actual proof either way
    return 'current';
  } catch {
    return 'undecryptable';
  }
}

async function backfillColumn(table, idColumn, column, updateSql) {
  const rows = await db.query(`SELECT ${idColumn} AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
  let backfilled = 0;
  const flagged = [];
  for (const row of rows) {
    const status = classify(row.value);
    if (status === 'skip' || status === 'current') continue;
    if (status === 'undecryptable') {
      flagged.push(row.id);
      continue;
    }
    await db.query(updateSql, [pii.encrypt(row.value), row.id]);
    backfilled += 1;
  }
  return { table: `${table}.${column}`, total: rows.length, backfilled, flagged };
}

async function main() {
  if (!process.env.PII_ENCRYPTION_KEY) {
    console.warn(
      '[backfillPii] WARNING: PII_ENCRYPTION_KEY is not set — running on the dev fallback key. ' +
      'Rows backfilled now will need re-backfilling once a real key is set. ' +
      'Set PII_ENCRYPTION_KEY to the real production key before running this for real.'
    );
  }
  const results = [
    await backfillColumn('users', 'id', 'phone', 'UPDATE users SET phone = $1 WHERE id = $2'),
    await backfillColumn('organizers', 'id', 'settlement_account', 'UPDATE organizers SET settlement_account = $1 WHERE id = $2'),
  ];
  let anyFlagged = false;
  for (const r of results) {
    console.log(`[backfillPii] ${r.table}: ${r.backfilled} of ${r.total} row(s) encrypted (${r.total - r.backfilled - r.flagged.length} already current)`);
    if (r.flagged.length > 0) {
      anyFlagged = true;
      console.warn(`[backfillPii]   ⚠ ${r.flagged.length} row(s) in ${r.table} look like ciphertext but do NOT decrypt under the current PII_ENCRYPTION_KEY — left untouched. ids: ${r.flagged.join(', ')}`);
    }
  }
  if (anyFlagged) {
    console.warn(
      '[backfillPii] Some rows were flagged rather than encrypted — they appear to already be encrypted, but under a ' +
      'DIFFERENT key than the one this ran with (e.g. an earlier key rotation). Re-run this with that earlier key set ' +
      'as PII_ENCRYPTION_KEY to decrypt them for inspection, or investigate before assuming they are safe to leave as-is.'
    );
  }
  console.log('[backfillPii] done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfillPii] failed:', err);
    process.exit(1);
  });
