// src/utils/piiCrypto.js
// Application-level encryption at rest for the handful of columns that are
// both genuinely sensitive and never queried by exact match — a customer's
// phone number and an organizer's settlement (bank/mobile money) account.
// Email is deliberately NOT encrypted here: it's looked up by exact match
// everywhere (login, password reset, admin lookups, ticket transfer-by-email)
// and AES-GCM's random IV makes the same plaintext encrypt differently every
// time, which would break every one of those WHERE email = $1 queries unless
// paired with a separate deterministic hash index — a real project on its
// own, out of scope here. Password hashes are already one-way (bcrypt) and
// aren't touched by this file.
//
// AES-256-GCM, one random 12-byte IV per value, stored as
// base64(iv || authTag || ciphertext) in the same TEXT column the plaintext
// used to live in — no schema change needed. decrypt() tolerates a value
// that isn't in this format (e.g. a legacy plaintext row written before this
// shipped, or NULL) by returning it unchanged rather than throwing, so a
// rolling deploy never 500s on old data.
const crypto = require('crypto');

// Same fallback pattern already used for JWT_SECRET in auth.js: a fixed dev
// default so local/test runs work with zero config, clearly named so it's
// obvious this must be overridden before real PII ever reaches production.
const RAW_KEY = process.env.PII_ENCRYPTION_KEY || 'dev-pii-key-change-me-in-production';
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest(); // -> 32 bytes, AES-256
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  try {
    const raw = Buffer.from(value, 'base64');
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) return value; // too short to be our format — legacy plaintext
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (err) {
    // Not something this key can decrypt — most likely a legacy plaintext
    // value from before encryption was added. Return it as-is rather than
    // fail the request; it'll be re-encrypted the next time it's written.
    return value;
  }
}

module.exports = { encrypt, decrypt };
