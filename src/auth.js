// src/auth.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the JWT's own expiresIn

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// Verification/reset tokens are sent to the user in plaintext (email/SMS)
// but only ever stored as a hash — a leaked DB dump can't be replayed to
// verify an email or reset a password.
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Creates a tracked session row and signs a JWT whose jti points at it, so
// this one session can be individually revoked later — logout, "sign out
// other devices", and forced sign-out after a password reset all depend on
// this row existing (a bare stateless JWT has no way to be revoked before
// its own expiry).
async function issueSessionToken(user, userAgent) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const session = await db.one(
    'INSERT INTO sessions (user_id, user_agent, expires_at) VALUES ($1, $2, $3) RETURNING id',
    [user.id, userAgent ? String(userAgent).slice(0, 300) : null, expiresAt]
  );
  const token = jwt.sign(
    { sub: user.id, role: user.role, name: user.name, email: user.email, jti: session.id },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  return { token, sessionId: session.id };
}

// A short-lived, narrowly-scoped token issued after a correct password but
// before MFA is satisfied. It carries no jti/session row and no role, so it
// can never pass requireAuth — it's only ever accepted at POST /mfa/verify.
function issueMfaChallengeToken(user) {
  return jwt.sign({ sub: user.id, mfaPending: true }, JWT_SECRET, { expiresIn: '5m' });
}

function verifyMfaChallengeToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (!payload.mfaPending) throw new Error('Not an MFA challenge token');
  return payload;
}

// Express middleware: requires a valid session JWT in Authorization: Bearer <token>,
// and that its underlying session hasn't been revoked or expired.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!payload.jti) return res.status(401).json({ error: 'Invalid or expired token' });

  try {
    const session = await db.one('SELECT * FROM sessions WHERE id = $1', [payload.jti]);
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session has been revoked or expired — please log in again' });
    }
    // Best-effort — a failed heartbeat write should never block the request.
    db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [session.id]).catch(() => {});
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

// Express middleware factory: requires one of the given roles (after requireAuth)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashToken,
  generateToken,
  issueSessionToken,
  issueMfaChallengeToken,
  verifyMfaChallengeToken,
  requireAuth,
  requireRole,
  JWT_SECRET,
};
