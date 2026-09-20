// src/routes/auth.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const {
  hashPassword,
  verifyPassword,
  hashToken,
  generateToken,
  issueSessionToken,
  issueMfaChallengeToken,
  verifyMfaChallengeToken,
  requireAuth,
} = require('../auth');
const { audit } = require('../utils/audit');
const { validateRegistration } = require('../security');
const { notify } = require('../utils/notify');
const mfa = require('../utils/mfa');
const pii = require('../utils/piiCrypto');

const router = express.Router();

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PHONE_VERIFY_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const MAX_PHONE_ATTEMPTS = 5;

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    emailVerified: !!row.email_verified_at,
    phoneVerified: !!row.phone_verified_at,
    mfaEnabled: !!row.mfa_enabled_at,
  };
}

// Generates a fresh email-verification token for a user, invalidating any
// still-pending one, and sends it. Shared by /register and /resend-verification.
async function sendEmailVerification(user) {
  await db.query('DELETE FROM email_verifications WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  const rawToken = generateToken(24);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString();
  await db.query(
    'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, hashToken(rawToken), expiresAt]
  );
  const verifyUrl = process.env.APP_URL ? `${process.env.APP_URL}/verify-email?token=${rawToken}` : null;
  await notify(user.id, 'auth.email_verification', { token: rawToken, verifyUrl }, ['email']);
}

// ===================== REGISTER / LOGIN =====================

router.post('/register', validateRegistration, async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  const allowedRoles = ['customer', 'organizer_owner'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer';

  const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = hashPassword(password);
  const created = await db.one(
    'INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, email, passwordHash, finalRole, pii.encrypt(phone) || null]
  );

  await audit(created.id, 'user.registered', 'user', created.id, { role: finalRole });
  await sendEmailVerification(created);

  const { token } = await issueSessionToken(
    { id: created.id, role: finalRole, name, email },
    req.headers['user-agent']
  );
  res.status(201).json({ token, user: publicUser(created) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const row = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };

  // A correct password isn't enough on its own once MFA is enabled — issue
  // a narrow, short-lived challenge token instead of a real session, and
  // make the caller complete /mfa/verify with a TOTP or backup code.
  if (row.mfa_enabled_at) {
    const challengeToken = issueMfaChallengeToken(user);
    return res.json({ mfaRequired: true, challengeToken });
  }

  await audit(user.id, 'user.login', 'user', user.id, {});
  const { token } = await issueSessionToken(user, req.headers['user-agent']);
  res.json({ token, user: publicUser(row) });
});

router.post('/mfa/verify', async (req, res) => {
  const { challengeToken, code } = req.body;
  if (!challengeToken || !code) return res.status(400).json({ error: 'challengeToken and code are required' });

  let payload;
  try {
    payload = verifyMfaChallengeToken(challengeToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired MFA challenge — please log in again' });
  }

  const row = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [payload.sub]);
  if (!row || !row.mfa_enabled_at) return res.status(401).json({ error: 'MFA is not enabled on this account' });

  let ok = mfa.verifyToken(code, row.mfa_secret);
  let usedBackupCodeId = null;
  if (!ok) {
    const backupCodes = await db.query('SELECT * FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL', [row.id]);
    const hashed = mfa.hashCode(String(code).trim().toUpperCase());
    const match = backupCodes.find((c) => c.code_hash === hashed);
    if (match) {
      ok = true;
      usedBackupCodeId = match.id;
    }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid authentication code' });
  if (usedBackupCodeId) {
    await db.query('UPDATE mfa_backup_codes SET used_at = now() WHERE id = $1', [usedBackupCodeId]);
  }

  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  await audit(user.id, 'user.login', 'user', user.id, { mfa: true, usedBackupCode: !!usedBackupCodeId });
  const { token } = await issueSessionToken(user, req.headers['user-agent']);
  res.json({ token, user: publicUser(row) });
});

router.post('/logout', requireAuth, async (req, res) => {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.jti]);
  res.json({ message: 'Logged out' });
});

router.get('/me', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  res.json({ user: publicUser(row) });
});

// ===================== EMAIL VERIFICATION =====================

router.post('/resend-verification', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (row.email_verified_at) return res.status(400).json({ error: 'Email is already verified' });
  await sendEmailVerification(row);
  res.json({ message: 'Verification email sent' });
});

router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const record = await db.one('SELECT * FROM email_verifications WHERE token_hash = $1', [hashToken(token)]);
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired verification token' });
  }
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [record.user_id]);
  await db.query('UPDATE email_verifications SET used_at = now() WHERE id = $1', [record.id]);
  await audit(record.user_id, 'user.email_verified', 'user', record.user_id, {});
  res.json({ message: 'Email verified' });
});

// ===================== PHONE VERIFICATION =====================

router.post('/send-phone-verification', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (!row.phone) return res.status(400).json({ error: 'Add a phone number to your account first' });
  if (row.phone_verified_at) return res.status(400).json({ error: 'Phone is already verified' });

  await db.query('DELETE FROM phone_verifications WHERE user_id = $1 AND used_at IS NULL', [row.id]);
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + PHONE_VERIFY_TTL_MS).toISOString();
  await db.query(
    'INSERT INTO phone_verifications (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [row.id, mfa.hashCode(code), expiresAt]
  );
  await notify(row.id, 'auth.phone_verification', { code }, ['sms']);
  res.json({ message: 'Verification code sent' });
});

router.post('/verify-phone', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const record = await db.one(
    'SELECT * FROM phone_verifications WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [req.user.sub]
  );
  if (!record || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'No pending verification code — request a new one' });
  }
  if (record.attempt_count >= MAX_PHONE_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many incorrect attempts — request a new code' });
  }
  if (mfa.hashCode(String(code).trim()) !== record.code_hash) {
    await db.query('UPDATE phone_verifications SET attempt_count = attempt_count + 1 WHERE id = $1', [record.id]);
    return res.status(400).json({ error: 'Incorrect code' });
  }
  await db.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [req.user.sub]);
  await db.query('UPDATE phone_verifications SET used_at = now() WHERE id = $1', [record.id]);
  await audit(req.user.sub, 'user.phone_verified', 'user', req.user.sub, {});
  res.json({ message: 'Phone verified' });
});

// ===================== PASSWORD RESET / CHANGE =====================

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  // Always respond the same way whether or not the account exists — this
  // endpoint must never be usable to enumerate registered emails.
  const row = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (row) {
    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [row.id]);
    const rawToken = generateToken(24);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    await db.query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [row.id, hashToken(rawToken), expiresAt]
    );
    const resetUrl = process.env.APP_URL ? `${process.env.APP_URL}/reset-password?token=${rawToken}` : null;
    await notify(row.id, 'auth.password_reset', { token: rawToken, resetUrl }, ['email']);
  }
  res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const record = await db.one('SELECT * FROM password_resets WHERE token_hash = $1', [hashToken(token)]);
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), record.user_id]);
  await db.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [record.id]);
  // A password reset means the old credential may have been compromised —
  // sign every existing session out so a resumed attacker session dies too.
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [record.user_id]);
  await audit(record.user_id, 'user.password_reset', 'user', record.user_id, {});
  await notify(record.user_id, 'auth.password_changed', {}, ['email']);
  res.json({ message: 'Password has been reset. Please log in again.' });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), row.id]);
  await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL',
    [row.id, req.user.jti]
  );
  await audit(row.id, 'user.password_changed', 'user', row.id, {});
  await notify(row.id, 'auth.password_changed', {}, ['email']);
  res.json({ message: 'Password changed. Other sessions have been signed out.' });
});

// ===================== MFA (TOTP) =====================

router.post('/mfa/setup', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (row.mfa_enabled_at) {
    return res.status(400).json({ error: 'MFA is already enabled — disable it first to reconfigure' });
  }
  const secret = mfa.generateSecret();
  await db.query('UPDATE users SET mfa_pending_secret = $1 WHERE id = $2', [secret, row.id]);
  res.json({ secret, otpauthUrl: mfa.otpauthUrl(row.email, secret) });
});

router.post('/mfa/enable', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (!row.mfa_pending_secret) return res.status(400).json({ error: 'Call /mfa/setup first' });
  if (!mfa.verifyToken(code, row.mfa_pending_secret)) {
    return res.status(400).json({ error: 'Incorrect code — check your authenticator app and try again' });
  }

  await db.query(
    'UPDATE users SET mfa_secret = $1, mfa_pending_secret = NULL, mfa_enabled_at = now() WHERE id = $2',
    [row.mfa_pending_secret, row.id]
  );
  await db.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [row.id]);
  const backupCodes = mfa.generateBackupCodes();
  for (const code of backupCodes) {
    await db.query('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)', [row.id, mfa.hashCode(code)]);
  }

  await audit(row.id, 'user.mfa_enabled', 'user', row.id, {});
  await notify(row.id, 'auth.mfa_enabled', {}, ['email']);
  res.json({ message: 'MFA enabled — store these backup codes somewhere safe, they will not be shown again', backupCodes });
});

router.post('/mfa/disable', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required to disable MFA' });

  const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  if (!verifyPassword(password, row.password_hash)) return res.status(401).json({ error: 'Incorrect password' });

  await db.query(
    'UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL WHERE id = $1',
    [row.id]
  );
  await db.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [row.id]);
  await audit(row.id, 'user.mfa_disabled', 'user', row.id, {});
  await notify(row.id, 'auth.mfa_disabled', {}, ['email']);
  res.json({ message: 'MFA disabled' });
});

// ===================== SESSIONS =====================

router.get('/sessions', requireAuth, async (req, res) => {
  const rows = await db.query(
    'SELECT id, user_agent, created_at, expires_at, last_seen_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.sub]
  );
  const sessions = rows.map((s) => ({
    ...s,
    current: s.id === req.user.jti,
    active: !s.revoked_at && new Date(s.expires_at) > new Date(),
  }));
  res.json({ sessions });
});

router.post('/sessions/:id/revoke', requireAuth, async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = await db.one('SELECT * FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, req.user.sub]);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
  await audit(req.user.sub, 'user.session_revoked', 'session', sessionId, { self: sessionId === req.user.jti });
  res.json({ message: 'Session revoked' });
});

router.post('/sessions/revoke-all', requireAuth, async (req, res) => {
  const includeCurrent = !!(req.body && req.body.includeCurrent);
  const params = [req.user.sub];
  let sql = 'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL';
  if (!includeCurrent) {
    sql += ' AND id != $2';
    params.push(req.user.jti);
  }
  await db.query(sql, params);
  await audit(req.user.sub, 'user.sessions_revoked_all', 'user', req.user.sub, { includeCurrent });
  res.json({ message: includeCurrent ? 'All sessions revoked — please log in again' : 'All other sessions revoked' });
});

// ===================== ACCOUNT DELETION =====================

// Self-service "right to erasure": scrubs personally-identifying fields but
// keeps the user row (and its id) intact — orders, tickets, refunds, and
// audit_log all reference user_id, and hard-deleting would either orphan
// that history or require cascading through financial/legal records this
// platform is required to keep. Anonymizing in place is the same pattern
// already used for a cancelled event or removed ticket type (a deleted_at
// flag, never a DELETE).
router.post('/delete-account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required to confirm account deletion' });

  const row = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [req.user.sub]);
  if (!row) return res.status(404).json({ error: 'Account not found' });
  if (!verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const anonymizedEmail = `deleted-user-${row.id}@deleted.afrotickets.invalid`;
  const unusablePasswordHash = hashPassword(crypto.randomBytes(32).toString('hex'));
  await db.query(
    `UPDATE users SET
       name = 'Deleted user',
       email = $1,
       phone = NULL,
       password_hash = $2,
       mfa_secret = NULL,
       mfa_pending_secret = NULL,
       mfa_enabled_at = NULL,
       deleted_at = now()
     WHERE id = $3`,
    [anonymizedEmail, unusablePasswordHash, row.id]
  );
  await db.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [row.id]);
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.id]);
  await audit(row.id, 'user.account_deleted', 'user', row.id, {});

  res.json({ message: 'Your account has been deleted.' });
});

module.exports = router;
