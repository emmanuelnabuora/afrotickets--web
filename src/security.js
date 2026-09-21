// src/security.js
// Centralizes the hardening that matters once this API is reachable from the
// open internet (which it is, on Cloud Run with --allow-unauthenticated):
// rate limits sized per endpoint sensitivity, and a few input-shape checks
// that cost nothing and close off cheap abuse.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

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

// Ticket transfer: bounds a compromised or scripted account from mass-
// transferring tickets out before it's noticed. Keyed by user id (these
// routes require auth) rather than IP, so one person's transfers never
// throttle anyone else sharing their network.
const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.sub ? `u:${req.user.sub}` : ipKeyGenerator(req.ip)),
  message: { error: 'Too many transfer attempts — please wait a few minutes and try again.' },
});

// Check-in: real door staff scan in rapid bursts, so this is sized
// generously per staff member (keyed by user id, same reasoning as above) —
// it exists to bound a compromised scanner or scripted client hammering the
// endpoint fishing for valid ticket codes, not to slow down a real line.
const checkinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.sub ? `u:${req.user.sub}` : ipKeyGenerator(req.ip)),
  message: { error: 'Too many check-in requests — please slow down.' },
});

// Ticketmaster aggregation calls an external API with a real daily quota
// (5,000 requests/day on Ticketmaster's free Discovery API tier) — this
// bounds cost/quota exposure from a single client hammering it, same
// reasoning as afroguideLimiter above for the Anthropic API.
const aggregationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many discovery searches — please wait a few minutes and try again.' },
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

// Event creation: closes off garbage/oversized input reaching the DB or
// getting rendered back to a browser later (an unbounded description, a
// starts_at that isn't really a date, a currency that isn't a real code).
const CATEGORY_RE = /^[a-zA-Z0-9 &/'-]{1,60}$/;

function validateEventCreation(req, res, next) {
  const { name, category, description, venue, city, country, startsAt, currency } = req.body;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) {
    return res.status(400).json({ error: 'name must be 1-200 characters' });
  }
  if (typeof category !== 'string' || !CATEGORY_RE.test(category)) {
    return res.status(400).json({ error: "category must be 1-60 characters (letters, numbers, spaces, &/-')" });
  }
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 5000)) {
    return res.status(400).json({ error: 'description must be at most 5000 characters' });
  }
  for (const [field, value] of [['venue', venue], ['city', city], ['country', country]]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 200)) {
      return res.status(400).json({ error: `${field} must be at most 200 characters` });
    }
  }
  const startsAtDate = new Date(startsAt);
  if (typeof startsAt !== 'string' || Number.isNaN(startsAtDate.getTime())) {
    return res.status(400).json({ error: 'startsAt must be a valid date/time' });
  }
  if (startsAtDate.getTime() < Date.now()) {
    return res.status(400).json({ error: 'startsAt must be in the future' });
  }
  if (currency !== undefined && currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    return res.status(400).json({ error: 'currency must be a 3-letter ISO code (e.g. USD, KES)' });
  }
  next();
}

// Ticket types are submitted inline with event creation (req.body.ticketTypes)
// rather than through their own endpoint — validated here so a bad price or
// quantity is rejected before an event row (and its dependent ticket_types
// rows) is ever created.
function validateTicketTypeCreation(req, res, next) {
  const { ticketTypes } = req.body;
  if (!Array.isArray(ticketTypes) || ticketTypes.length === 0) {
    return res.status(400).json({ error: 'At least one ticket type is required' });
  }
  if (ticketTypes.length > 50) {
    return res.status(400).json({ error: 'A single event cannot have more than 50 ticket types' });
  }
  for (const [i, tt] of ticketTypes.entries()) {
    if (!tt || typeof tt.name !== 'string' || tt.name.trim().length < 1 || tt.name.length > 100) {
      return res.status(400).json({ error: `ticketTypes[${i}].name must be 1-100 characters` });
    }
    if (typeof tt.price !== 'number' || !Number.isFinite(tt.price) || tt.price < 0 || tt.price > 1000000) {
      return res.status(400).json({ error: `ticketTypes[${i}].price must be a number between 0 and 1,000,000` });
    }
    if (!Number.isInteger(tt.quantity) || tt.quantity < 1 || tt.quantity > 1000000) {
      return res.status(400).json({ error: `ticketTypes[${i}].quantity must be a whole number between 1 and 1,000,000` });
    }
  }
  next();
}

// Seat generation (organizers.js's POST /events/:id/seats) was previously
// unvalidated: rows/seatsPerRow only got checked against quantity_total
// AFTER multiplying them together, so a non-numeric, negative, zero, or
// fractional value could sail through — e.g. rows="abc" makes seatCount
// NaN, which is neither `> quantity_total` (NaN comparisons are always
// false) nor produces any loop iterations, so the route returned
// `201 Generated NaN seats` while silently creating zero rows. Negative
// values had the same silent-no-op failure mode. This closes that off by
// requiring both to be sane, bounded whole numbers before any arithmetic
// or DB work happens. The 1-1000 bounds on each factor keep the largest
// possible seatCount (1,000,000) in line with the existing ticket-type
// quantity cap above, so this can't be used to force a runaway insert loop
// even when quantity_total itself is large.
const SECTION_NAME_RE = /^[a-zA-Z0-9 &/'().-]{1,100}$/;
const TIER_RE = /^[a-zA-Z0-9 &/'-]{1,40}$/;

function validateSeatGeneration(req, res, next) {
  const { sectionName, tier, rows, seatsPerRow } = req.body;
  if (typeof sectionName !== 'string' || !SECTION_NAME_RE.test(sectionName)) {
    return res.status(400).json({ error: "sectionName must be 1-100 characters (letters, numbers, spaces, &/-'().)" });
  }
  if (tier !== undefined && tier !== null && (typeof tier !== 'string' || !TIER_RE.test(tier))) {
    return res.status(400).json({ error: "tier must be 1-40 characters (letters, numbers, spaces, &/-')" });
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 1000) {
    return res.status(400).json({ error: 'rows must be a whole number between 1 and 1,000' });
  }
  if (!Number.isInteger(seatsPerRow) || seatsPerRow < 1 || seatsPerRow > 1000) {
    return res.status(400).json({ error: 'seatsPerRow must be a whole number between 1 and 1,000' });
  }
  next();
}

module.exports = {
  generalLimiter,
  authLimiter,
  checkoutLimiter,
  afroguideLimiter,
  aggregationLimiter,
  transferLimiter,
  checkinLimiter,
  validateRegistration,
  validateEventCreation,
  validateTicketTypeCreation,
  validateSeatGeneration,
};
