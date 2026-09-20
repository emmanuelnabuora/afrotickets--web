# Changelog — afrotickets-backend-gcp

All notable changes to the Cloud Run + Cloud SQL variant, in order.

## [1.10.0] — Refunds and disputes (production-readiness audit, critical finding #2)
- New `refunds` table and `orders.refunded_cents` running-total column. A refund is always a **request first, decision second** — no money moves without a `platform_admin` approving it, which is the actual dispute-workflow the audit asked for.
- Customer-facing: `POST /api/refunds` (request a full or partial refund on a `paid`/`partially_refunded` order — validated against the order's real remaining balance, blocks a second request while one is already pending), `GET /api/refunds/mine`.
- Admin-facing: `GET /api/admin/refunds/pending`, `POST /api/admin/refunds/:id/approve`, `POST /api/admin/refunds/:id/reject` — same review-queue pattern as organizer/event approval.
- **Approval uses the exact same atomic-conditional-UPDATE pattern as the v1.9.0 oversell fix**: `UPDATE orders SET refunded_cents = refunded_cents + $1 WHERE id = $2 AND refunded_cents + $1 <= total_cents`, inside a transaction, checked by rows-affected. Two admins approving two different pending refund requests on the same order at the same instant can't jointly refund more than the order actually cost — one gets a clean 409 instead of a double-refund.
- A full refund (amount reaches the order's total) invalidates every ticket on the order (`status = 'invalidated'`) and sets `orders.status = 'refunded'` — this automatically blocks both check-in and resale, since both already gate on `status = 'valid'`. A partial refund leaves the order `partially_refunded` and the ticket(s) valid — the customer keeps their ticket.
- Provider dispatch is honest about what's actually wired up: mock provider refunds instantly (mirrors the original mock charge flow); Stripe calls the real Refunds API (`stripe.refunds.create`, with Stripe's own request-level idempotency key so a retry can't double-refund); **M-Pesa is flagged `manual_required` rather than faked** — Safaricom's B2C reversal API needs a separate certificate-encrypted security credential, initiator name, and B2C shortcode this integration was never configured with, and pretending to reverse a real payment without them would be dishonest about money actually moving.
- If the provider genuinely fails after `refunded_cents` was already committed (proved with a real blocked network call to `api.stripe.com`, not a stub), the reservation is rolled back so a failed attempt doesn't permanently eat into the order's refundable balance.
- **Verified with real concurrency and real failure modes**: full refund → ticket invalidation → resale/check-in now correctly blocked; partial refund → ticket stays valid; rejection → order/ticket state unchanged; over-the-remaining-balance request → 400; two concurrent approvals on the same order that would jointly overspend the total → exactly one 200, one clean 409, `refunded_cents` never exceeds `total_cents`. Genuine Stripe network failure → refund marked `failed`, `refunded_cents` correctly rolled back to 0. M-Pesa-settled order → refund correctly marked `manual_required`, no money-movement faked. Every scenario passed on both `afrotickets-backend` (SQLite) and `afrotickets-backend-gcp` (Postgres).

## [1.9.0] — Fixed the oversell race condition (production-readiness audit, critical finding #1)
- `validateAndResolveItems()` did a plain `SELECT` outside any lock to check `quantity_total - quantity_reserved - quantity_sold`, then a separate, later `UPDATE ticket_types SET quantity_reserved = quantity_reserved + $1` never re-checked capacity — two simultaneous checkouts for the last unit(s) could both pass the check and both reserve, overselling the event. Same gap existed for seats (`event_seats.status`).
- Fixed by replacing the unconditional reservation `UPDATE`s in `reserveAndCreateOrder()` with atomic conditional `UPDATE`s, run inside the existing transaction, that check and claim capacity in a single statement:
  - General admission: `UPDATE ticket_types SET quantity_reserved = quantity_reserved + $1 WHERE id = $2 AND quantity_reserved + quantity_sold + $1 <= quantity_total RETURNING id` — 0 rows back means someone else already claimed the remaining inventory, and the whole order (and any other items already reserved in the same cart) rolls back with a clean `409`.
  - Seats: `UPDATE event_seats SET status = 'reserved' WHERE id = $1 AND status = 'available' RETURNING id`, same all-or-nothing rollback on a lost race.
  - `validateAndResolveItems()`'s original `SELECT` is kept as a fast pre-check for a good error message on obviously sold-out items, but it is no longer the authority — the atomic `UPDATE` inside the transaction is.
  - 409 responses from a lost race now propagate their real status code (previously flattened to a generic 500) across all three checkout paths (mock, M-Pesa, Stripe).
- **Verified with genuine concurrency, not a simulation**: seeded a ticket type and a seat each with capacity for exactly 1, then fired 10 truly concurrent requests at each — via real parallel HTTP requests against a live server backed by a real local Postgres instance for the GCP/Postgres variant, and via 10 separate OS processes each opening their own SQLite connection to the same database file for the SQLite/Railway variant (the scenario that actually exercises multi-process file-level contention, since a single Node process serializes requests with no `await` gap between them). In every run: exactly 1 winner, 9 clean 409s, and the database ended up exactly consistent (`quantity_reserved + quantity_sold <= quantity_total`; the seat claimed exactly once).
- Mirrored identically in both `afrotickets-backend` (SQLite) and `afrotickets-backend-gcp` (Postgres).

## [1.8.0] — Real notification delivery (SMS, email, WhatsApp)
- Three real provider integrations, each a plain `fetch()` call with no heavy SDK: SendGrid (email), Africa's Talking (SMS), Meta's WhatsApp Business Cloud API — all gated by `isConfigured()` with a graceful fallback to console logging, matching the same pattern as the M-Pesa/Stripe integrations
- Added the `phone` column to `users` (it never existed before — genuinely needed for SMS/WhatsApp), via the same safe idempotent-migration pattern used for `notifications.read_at`
- Phone numbers are captured at registration (optional field) and opportunistically during M-Pesa checkout (captured even if the STK push itself fails, since the number is provided before the network call)
- Verified real network calls to all three providers with fake credentials — genuine `403`s from each, all caught cleanly
- Verified the property that actually matters: ran a full real checkout with all three notification providers "configured" and confirmed the order still completed and minted a ticket while the notification failures happened harmlessly in the background
- **Fixed a real bug found during testing**: making `notify()` async while every call site remained fire-and-forget (no `await`/`.catch()`) meant an internal failure would become an unhandled promise rejection — which crashes Node by default. Proved this concretely by forcing a real foreign-key violation on every channel via a fire-and-forget call, then rewrote `notify()` so it can structurally never reject, and re-verified the same forced-failure scenario survives cleanly on both backend variants

## [1.7.0] — Real Stripe integration + card checkout in the prototype
- `src/utils/stripeProvider.js`: real PaymentIntents API via the official Stripe SDK, plus genuine cryptographic webhook signature verification (Stripe's own HMAC scheme, not a stub) — verified by hand-building a real Stripe-signed payload and confirming valid/tampered/wrong-secret signatures are each handled correctly
- `POST /api/orders` opens a real PaymentIntent when `paymentMethod: "stripe"` and Stripe env vars are configured — order/reservation created first since a PaymentIntent has no side effects until the customer confirms their card client-side (the opposite ordering from M-Pesa's STK Push, which must succeed before anything is reserved)
- `POST /api/orders/webhook/stripe` — the real Stripe webhook endpoint, sharing `finalizeOrderPayment()` with the mock and M-Pesa webhooks; idempotent via Stripe's own `event.id`
- New `GET /api/config` — public endpoint exposing the Stripe *publishable* key (safe to expose; can't authorize charges alone) so the frontend can initialize Stripe.js without hardcoding a key per deployment
- `afrotickets-prototype.html` now does a real Stripe Elements card checkout when connected to a backend with Stripe configured: mounts a real card input, calls `stripe.confirmCardPayment()` client-side, then polls for the webhook to actually finalize the order — verified end-to-end (checkout → simulated webhook → poll resolving to a real minted ticket) even though live card confirmation itself needs a real browser + Stripe.js to exercise fully
- Confirmed the failure/rollback path for real: a genuine (network-blocked, same restriction as M-Pesa) PaymentIntent creation failure correctly marked the order `failed` and released the already-reserved inventory back to available — this is the trickier of the two rollback directions since Stripe's order-then-intent sequence (unlike M-Pesa's intent-then-order) means inventory really is reserved before Stripe is ever contacted

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
