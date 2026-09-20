// src/utils/ticketmasterProvider.js
// Ticketmaster event discovery aggregation — "real when configured, honest
// fallback otherwise", the same pattern used elsewhere in this codebase for
// M-Pesa B2C payouts and AfroGuide's AI search. AfroTickets never sells or
// processes payment for these events; they're shown purely as discovery
// content to make the catalog feel fuller, with an outbound link to
// Ticketmaster's own checkout — affiliate-tracked via Impact.com when that's
// configured, a plain direct link when it isn't. Nothing here ever
// fabricates an event or a price; with no API key configured, callers get
// an honest empty result, not placeholder data.
const DISCOVERY_BASE_URL = 'https://app.ticketmaster.com/discovery/v2';
const CACHE_TTL_MS = Number(process.env.AGGREGATION_CACHE_TTL_MS) || 10 * 60 * 1000; // 10 min

// In-memory, per-process cache. Ticketmaster's Discovery API has a real daily
// quota (5,000 requests/day on the free tier), so caching identical queries
// for a short window matters here in a way it doesn't for most of this
// codebase's other external calls. Deliberately not shared across Cloud Run
// instances or persisted — a discovery cache going cold on a cold start or
// scale-out event is a non-issue; it just means one extra live API call.
const cache = new Map(); // key -> { expiresAt, data }

function isConfigured() {
  return !!process.env.TICKETMASTER_API_KEY;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Wraps a Ticketmaster event URL in an Impact.com tracking link when a
// template is configured; otherwise returns the direct URL unchanged. The
// exact tracking-link shape (account SID, program ID, media partner ID) is
// specific to a signed-up Impact.com publisher account, so rather than
// guess at parameters that would look real but aren't, this takes a full
// URL template with a `{url}` placeholder that gets filled in once real
// affiliate program details exist. No template configured means every
// outbound link is just the plain, honest Ticketmaster URL — functional,
// just untracked.
function buildAffiliateLink(destinationUrl) {
  const template = process.env.IMPACT_TRACKING_LINK_TEMPLATE;
  if (!template || !destinationUrl) return destinationUrl;
  return template.replace('{url}', encodeURIComponent(destinationUrl));
}

function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (b.width || 0) - (a.width || 0));
  const wide = sorted.find((img) => img.ratio === '16_9') || sorted[0];
  return wide?.url || null;
}

function normalizeEvent(raw) {
  const venue = raw._embedded?.venues?.[0];
  const priceRange = Array.isArray(raw.priceRanges) && raw.priceRanges.length > 0 ? raw.priceRanges[0] : null;
  return {
    source: 'ticketmaster',
    externalId: raw.id,
    name: raw.name,
    category: raw.classifications?.[0]?.segment?.name || null,
    venue: venue?.name || null,
    city: venue?.city?.name || null,
    country: venue?.country?.name || null,
    startsAt: raw.dates?.start?.dateTime || null,
    imageUrl: pickImage(raw.images),
    priceRange: priceRange
      ? { min: priceRange.min, max: priceRange.max, currency: priceRange.currency }
      : null,
    externalUrl: buildAffiliateLink(raw.url),
  };
}

async function searchEvents({ keyword, city, countryCode, page, size } = {}) {
  const cappedSize = Math.min(Math.max(Number(size) || 20, 1), 20);
  const cappedPage = Math.max(Number(page) || 0, 0);
  const cacheKey = JSON.stringify({
    keyword: keyword || '',
    city: city || '',
    countryCode: countryCode || '',
    page: cappedPage,
    size: cappedSize,
  });

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    apikey: process.env.TICKETMASTER_API_KEY,
    page: String(cappedPage),
    size: String(cappedSize),
  });
  if (keyword) params.set('keyword', keyword);
  if (city) params.set('city', city);
  if (countryCode) params.set('countryCode', countryCode);

  const res = await fetch(`${DISCOVERY_BASE_URL}/events.json?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ticketmaster Discovery API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const rawEvents = data._embedded?.events || [];
  const events = rawEvents.map(normalizeEvent);
  const result = {
    events,
    page: {
      number: data.page?.number ?? cappedPage,
      totalPages: data.page?.totalPages ?? (events.length > 0 ? cappedPage + 1 : 0),
      totalElements: data.page?.totalElements ?? events.length,
    },
  };
  cacheSet(cacheKey, result);
  return result;
}

module.exports = { isConfigured, searchEvents, normalizeEvent, buildAffiliateLink, pickImage };
