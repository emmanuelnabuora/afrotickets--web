// src/security.js
// Centralizes the hardening that matters once this API is reachable from the
// open internet (which it is, on Cloud Run with --allow-unauthenticated):
// rate limits sized per endpoint sensitivity, and a few input-shape checks
// that cost nothing and close off cheap abuse.
const rateLimit = require('express-rate-limit');

// General API traffic — generous, just a backstop against runaway clients
// or basic scraping, not meant to bother a real user.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});

// Login/register: the classic brute-force and credential-stuffing target.
// Tight enough to make guessing passwords impractical, loose enough that a
// real person mistyping their password a few times never hits it.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Overridable only for local/test runs that need to exercise many auth
  // flows back-to-back (e.g. a test script logging in dozens of times) —
  // defaults to the real production-sized budget otherwise.
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please wait 15 minutes and try again.' },
});

// Checkout: bounds card-testing / inventory-hold abuse (someone scripting
// repeated orders to lock up seat inventory without ever paying) without
// limiting a genuine customer buying multiple ticket types across events.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts — please wait a few minutes and try again.' },
});

// AfroGuide calls a paid external LLM API per request — this bounds cost
// exposure from a single client hammering it, independent of the general
// API traffic limiter.
const afroguideLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AfroGuide searches — please wait a few minutes and try again.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRegistration(req, res, next) {
  const { name, email, password } = req.body;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) {
    return res.status(400).json({ error: 'name must be 1-200 characters' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  next();
}

module.exports = { generalLimiter, authLimiter, checkoutLimiter, afroguideLimiter, validateRegistration };
