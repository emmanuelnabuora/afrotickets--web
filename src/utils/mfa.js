// src/utils/mfa.js
// TOTP-based MFA (RFC 6238) via otplib, plus one-time backup codes for
// account recovery if the authenticator device is lost. Pure/stateless —
// no DB access here, so this file is identical in both backend variants.
const crypto = require('crypto');
const { authenticator } = require('otplib');

function generateSecret() {
  return authenticator.generateSecret();
}

function otpauthUrl(email, secret) {
  return authenticator.keyuri(email, 'AfroTickets', secret);
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch (err) {
    return false;
  }
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// Generates N human-typeable backup codes (e.g. "7K3F9-QXZ12"), returned in
// plaintext once by the caller — only their hashes are ever persisted.
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

module.exports = { generateSecret, otpauthUrl, verifyToken, hashCode, generateBackupCodes };
