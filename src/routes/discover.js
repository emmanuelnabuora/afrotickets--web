// src/routes/discover.js
// Event discovery aggregation from external sources (currently
// Ticketmaster) — shown alongside AfroTickets' own listings so the catalog
// feels fuller, but never sold through this platform. Deliberately a
// separate route path from /api/events (not a param under it) so a request
// for "aggregated" can never collide with /api/events/:id's numeric-id
// lookup, and so API consumers can tell at a glance that this returns
// external, not-purchasable-here content.
//
// "Real when configured, honest fallback otherwise": with no
// TICKETMASTER_API_KEY set, this returns an honest empty result rather than
// fabricating events — same principle as every other unconfigured
// integration in this codebase (M-Pesa B2C, AfroGuide's AI search).
const express = require('express');
const { aggregationLimiter } = require('../security');
const ticketmaster = require('../utils/ticketmasterProvider');

const router = express.Router();

const MAX_KEYWORD_LENGTH = 200;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

router.get('/events', aggregationLimiter, async (req, res) => {
  const { keyword, city, countryCode, page, size } = req.query;

  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > MAX_KEYWORD_LENGTH)) {
    return res.status(400).json({ error: `keyword must be a string under ${MAX_KEYWORD_LENGTH} characters` });
  }
  if (city !== undefined && (typeof city !== 'string' || city.length > 200)) {
    return res.status(400).json({ error: 'city must be a string under 200 characters' });
  }
  if (countryCode !== undefined && (typeof countryCode !== 'string' || !COUNTRY_CODE_RE.test(countryCode))) {
    return res.status(400).json({ error: 'countryCode must be a 2-letter ISO country code (e.g. US, KE)' });
  }

  if (!ticketmaster.isConfigured()) {
    return res.json({
      source: 'none',
      message: 'External event aggregation is not configured on this deployment.',
      events: [],
    });
  }

  try {
    const result = await ticketmaster.searchEvents({ keyword, city, countryCode, page, size });
    res.json({ source: 'ticketmaster', ...result });
  } catch (err) {
    console.error('Ticketmaster aggregation search failed:', err.message);
    // Same honest-degradation principle as AfroGuide: a live external-API
    // failure returns an empty result with source:'error', never fabricated
    // events and never a raw 500 that breaks a discovery page.
    res.json({ source: 'error', message: 'External event aggregation is temporarily unavailable.', events: [] });
  }
});

module.exports = router;
