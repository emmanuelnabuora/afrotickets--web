// src/routes/afroguide.js
// AfroGuide: natural-language event discovery. Real LLM call (Claude, via
// the Anthropic Messages API) constrained to select from the platform's own
// published events — it never invents an event that doesn't exist, because
// the prompt gives it the exact list to choose from and asks for event IDs
// back, not free-text descriptions. If no API key is configured, this
// degrades to a plain keyword filter over the same real event data rather
// than pretending to be AI-powered or returning nothing.
const express = require('express');
const db = require('../db');
const { afroguideLimiter } = require('../security');

const router = express.Router();

const ANTHROPIC_MODEL = 'claude-3-5-haiku-latest';
const MAX_QUERY_LENGTH = 500;

async function loadCandidateEvents() {
  const events = await db.query(
    `SELECT id, name, category, description, venue, city, country, starts_at, currency
     FROM events WHERE status = 'published' AND deleted_at IS NULL
     ORDER BY starts_at ASC LIMIT 100`
  );
  const withPrices = await Promise.all(
    events.map(async (e) => {
      const rows = await db.query(
        `SELECT MIN(price_cents) AS min_cents, MAX(price_cents) AS max_cents FROM ticket_types WHERE event_id = $1`,
        [e.id]
      );
      const { min_cents, max_cents } = rows[0] || {};
      return { ...e, min_price_cents: min_cents, max_price_cents: max_cents };
    })
  );
  return withPrices;
}

function fallbackSearch(query, events) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const scored = events
    .map((e) => {
      const haystack = `${e.name} ${e.category} ${e.city} ${e.country} ${e.venue} ${e.description || ''}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      return { event: e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    source: 'fallback',
    summary: scored.length > 0
      ? `Found ${scored.length} event${scored.length === 1 ? '' : 's'} matching keywords from your search.`
      : `No keyword matches for "${query}" — try a category, city, or artist name.`,
    results: scored.map((x) => x.event),
  };
}

async function aiSearch(query, events, apiKey) {
  const compactEvents = events.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    city: e.city,
    country: e.country,
    venue: e.venue,
    starts_at: e.starts_at,
    currency: e.currency,
    price_range: e.min_price_cents != null
      ? `${(e.min_price_cents / 100).toFixed(0)}-${(e.max_price_cents / 100).toFixed(0)} ${e.currency}`
      : 'unknown',
  }));

  const systemPrompt = `You are AfroGuide, a event discovery assistant for AfroTickets, a ticketing platform for African and diaspora live events.
You will be given a user's natural-language request and a JSON list of currently published events.
Select ONLY events from the provided list that genuinely match the request — never invent an event, city, artist, or price that isn't in the list.
If nothing matches well, return an empty matches array rather than forcing a weak match.
Respond with ONLY a JSON object, no markdown fences, no commentary outside the JSON, in exactly this shape:
{"summary": "one short sentence explaining what you found or didn't find", "matchedEventIds": [<event id numbers from the list, best match first>]}`;

  const userPrompt = `User request: "${query}"\n\nAvailable events:\n${JSON.stringify(compactEvents)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text || '{}';
  // Claude is instructed to return bare JSON, but strip markdown fences
  // defensively in case a model response wraps it anyway.
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AfroGuide returned an unparseable response');
  }

  const idSet = new Set(events.map((e) => e.id));
  const matchedIds = (parsed.matchedEventIds || []).filter((id) => idSet.has(id));
  const eventsById = new Map(events.map((e) => [e.id, e]));

  return {
    source: 'ai',
    summary: parsed.summary || 'Here is what I found.',
    results: matchedIds.map((id) => eventsById.get(id)),
  };
}

router.post('/search', afroguideLimiter, async (req, res) => {
  const { query } = req.body;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `query must be under ${MAX_QUERY_LENGTH} characters` });
  }

  const events = await loadCandidateEvents();
  if (events.length === 0) {
    return res.json({ source: 'none', summary: 'No published events to search yet.', results: [] });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json(fallbackSearch(query, events));
  }

  try {
    const result = await aiSearch(query, events, apiKey);
    res.json(result);
  } catch (err) {
    console.error('AfroGuide AI search failed, falling back to keyword search:', err.message);
    res.json(fallbackSearch(query, events));
  }
});

module.exports = router;
