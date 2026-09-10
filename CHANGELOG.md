# Changelog — afrotickets-backend-gcp

All notable changes to the Cloud Run + Cloud SQL variant, in order.

## [1.6.0] — Real M-Pesa (Safaricom Daraja) integration
- `src/utils/mpesaProvider.js`: real OAuth token fetch/cache, real STK Push initiation, and a parser for Safaricom's actual documented callback shape — not a mock
- `POST /api/orders` now sends a genuine STK Push to the customer's phone when `paymentMethod: "mpesa"` and M-Pesa env vars are configured (and the event's currency is KES) — the push must succeed before any inventory is reserved or order created, so a bad phone number or Safaricom outage never leaves a stuck reservation
- `POST /api/orders/webhook/mpesa/:secret` — the real Daraja callback endpoint, secured by a shared-secret URL path segment (Daraja can't send custom auth headers), sharing the same ticket-minting/inventory-release logic as the mock provider's webhook via a new `finalizeOrderPayment()` helper
- Falls back to the mock provider automatically whenever M-Pesa isn't fully configured or the event isn't priced in KES — checkout never hard-fails just because M-Pesa credentials aren't set up yet
- Verified against real conditions where possible: real STK-push network calls (failing due to this environment's own network restrictions, not a code bug — confirmed via the exact error message), and the full webhook lifecycle (success, retry/idempotency, user-cancellation) tested against synthetic Daraja-shaped payloads matching Safaricom's documented format exactly

## [1.5.0] — Saved events, notifications, and a version endpoint
- `POST/DELETE /api/saved/:eventId`, `GET /api/saved/mine` — real saved-events persistence
- `GET /api/notifications/mine`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`
- Added `read_at` column to `notifications` and a new `saved_events` table, with a safe idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` so upgrading an already-deployed database doesn't require a manual migration step
- Added `GET /version` (and `version` in `GET /health`) so you can always confirm exactly what's live after a deploy

## [1.4.0] — AfroGuide AI search
- `POST /api/afroguide/search` — real Claude API call (Anthropic Messages API) constrained to only select from actual published events, never inventing one
- Graceful fallback to a plain keyword search over the same real event data when `ANTHROPIC_API_KEY` isn't set or the AI call fails
- Dedicated rate limiter (20 req/15min) since this calls a paid external API per request

## [1.3.0] — Security hardening
- Helmet security headers on every response
- Rate limiting: general traffic (300/15min), auth endpoints (10/15min shared between register+login), checkout endpoints (20/15min) — deliberately excluding payment webhooks, which are server-to-server and HMAC-authenticated already
- Registration input validation (email format, 8-character minimum password)
- Request body size capped at 100kb
- `trust proxy` set correctly for Cloud Run's reverse proxy, so rate limits key on real client IPs

## [1.2.0] — Postgres migration
- Forked from the SQLite/Railway variant: every route converted from synchronous `node:sqlite` calls to async `pg` queries with a `withTransaction` helper
- Added `Dockerfile`, `.dockerignore`, and Cloud Run/Cloud SQL deployment instructions

## [1.1.0] — Seat-level inventory
- New `event_seats` table: individually bookable seats per event, layered on top of the existing ticket-type quantity counters
- Checkout accepts specific `seatIds` alongside plain `quantity`, with the same reservation → sold lifecycle
- `GET /api/events/:id/seats` (public seat map) and `POST /api/organizer/events/:id/seats` (generate a section)

## [1.0.0] — Initial Phase 2/3 MVP
- Auth (JWT + bcrypt), organizer onboarding, event creation and admin approval pipeline
- Ticket inventory with reservation holds, async payment flow with signed/idempotent webhooks
- Cryptographically signed QR tickets, check-in with duplicate detection (online + offline manifest)
- Verified resale marketplace, basic velocity-based fraud detection
- Platform admin: organizer/event approvals, fraud queue, audit log
