# AfroTickets API — Cloud Run + Cloud SQL variant

A working backend for AfroTickets: real auth, a real Postgres database, real
ticket inventory with reservation holds, an async payment flow with
signed/idempotent webhooks, cryptographically signed QR tickets, check-in
with duplicate detection (online and offline-manifest), organizer
onboarding and analytics, platform admin approvals, a verified resale
marketplace, and basic velocity-based fraud detection.

This is the same application as the Railway/local build (`afrotickets-backend`),
with one real change: the database layer is Postgres via the `pg` driver
instead of Node's built-in SQLite, because Cloud Run's stateless, horizontally
scalable instances can't share a local SQLite file the way a single
long-running Railway/VM process can. Every route, every table, and every
piece of business logic is otherwise identical — verified by running the
exact same test suite against both.

## Deploy to Cloud Run + Cloud SQL

```bash
# 0. One-time setup
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# 1. Create the Postgres instance (smallest tier — resize as needed)
gcloud sql instances create afrotickets-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=us-central1

gcloud sql databases create afrotickets --instance=afrotickets-db

gcloud sql users set-password postgres \
  --instance=afrotickets-db --password="CHOOSE_A_STRONG_PASSWORD"

# 1.5 Grant the Cloud Run service's identity permission to reach Cloud SQL —
# this is the single most commonly missed step, and without it every
# request will fail with a connection error even though everything else
# above is correct. Find the service account Cloud Run will use:
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# 2. Store secrets in Secret Manager instead of plain env vars
for name in jwt-secret ticket-secret webhook-secret manifest-secret; do
  openssl rand -hex 32 | gcloud secrets create $name --data-file=-
done
echo -n "CHOOSE_A_STRONG_PASSWORD" | gcloud secrets create db-password --data-file=-

# 3. Deploy — Cloud Run builds the Dockerfile in this directory automatically
gcloud run deploy afrotickets-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --add-cloudsql-instances YOUR_PROJECT_ID:us-central1:afrotickets-db \
  --set-env-vars "DATABASE_URL=postgresql://postgres:CHOOSE_A_STRONG_PASSWORD@localhost/afrotickets?host=/cloudsql/YOUR_PROJECT_ID:us-central1:afrotickets-db" \
  --set-secrets "JWT_SECRET=jwt-secret:latest,TICKET_SECRET=ticket-secret:latest,PAYMENT_WEBHOOK_SECRET=webhook-secret:latest,MANIFEST_SECRET=manifest-secret:latest"
```

(For production, put `DATABASE_URL` itself in Secret Manager too rather than
`--set-env-vars` — it's shown inline above only for clarity.)

**Run the seed once, against the deployed database**, from your machine with
the Cloud SQL Auth Proxy running locally (`cloud-sql-proxy YOUR_PROJECT_ID:us-central1:afrotickets-db`
in one terminal), then in another:
```bash
DATABASE_URL="postgresql://postgres:CHOOSE_A_STRONG_PASSWORD@localhost:5432/afrotickets" npm run seed
```

Cloud Run will print the service URL when the deploy finishes — that's what
you point `afrotickets-prototype.html`'s connection badge at.

## Why Postgres here, not SQLite

Cloud Run can run many instances of this service simultaneously and kill/
restart any of them at any time (including scaling to zero when idle). A
SQLite file living in one container's local disk would mean: two instances
have two different databases, and a fresh cold-start instance has an empty
one. Cloud SQL is a single shared database every instance talks to over the
network, which is the actual requirement here — this isn't a stylistic
preference, it's what makes the app correct once it's allowed to scale.

## Local development

```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm run seed
npm run dev             # http://localhost:8080
```

Seeded accounts (same as the Railway build):

| Role | Email | Password |
|---|---|---|
| Platform admin | admin@afrotickets.com | admin12345 |
| Organizer owner | zanele@solgenerationlive.com | organizer12345 |
| Check-in staff | staff@solgenerationlive.com | staff12345 |
| Customer | amara@example.com | customer12345 |

Two events are seeded: a general-admission show and a reserved-seating one
("Accra Jazz & Highlife Night") with a real 216-seat map across four
sections — this is what `afrotickets-prototype.html`'s interactive seat map
renders from when connected to a live backend.

## Why it's honest about what's simulated

We don't have live payment-provider or SMS/email credentials in this
environment. Rather than fake success messages, this implementation:

- Runs a real async payment flow: an order is created `pending_payment`,
  a payment intent is opened, and a **signed webhook callback** (HMAC,
  timing-safe verified, idempotent by event id) is what actually marks
  the order paid and issues tickets — the same mechanism a real M-Pesa,
  Stripe, or Flutterwave integration would use. Swap `simulateAsyncCallback`
  in `src/utils/mockPaymentProvider.js` for a real SDK call and the rest
  of the checkout pipeline needs no changes.
- Signs every digital ticket as a real JWT with its own secret (separate
  from login sessions), and persists the signed token — check-in verifies
  the cryptographic signature, then checks the database for single use.
- Logs every notification trigger point (order paid, ticket transferred,
  organizer approved, etc.) to an in-app `notifications` table and the
  console, so the *hooks* are real even though no SMS/email actually sends.

## Connecting the frontend prototype

`afrotickets-prototype.html` (delivered separately) now calls this API directly.
Its connection badge defaults to `localhost:4000` — this variant runs on `8080`
locally (or your Cloud Run URL in production), so tap the badge once and enter
the right address; it's saved for next time. Once connected, live events show
a green LIVE tag and go through real checkout, tickets, resale, check-in, and
admin actions; anything without that tag is static demo data shown so the app
still looks populated even against an empty database.

CORS is wide open (`cors()` with defaults) so this works from most setups, but
some browsers restrict `fetch` from a `file://` page more strictly than from
`http://`. If the badge won't go green, serve the HTML file instead of
double-clicking it:

```bash
cd wherever-you-saved-it
npx serve . -p 5500          # or: python3 -m http.server 5500
```

then open the printed URL (use a port other than 8080/4000 so it doesn't clash
with the backend itself).

## Try the full flow

```bash
# 1. Log in as the customer
TOKEN=$(curl -s -X POST localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"amara@example.com","password":"customer12345"}' | jq -r .token)

# 2. Browse the published event
curl -s localhost:8080/api/events/1 | jq

# 3. Buy 2 General Admission tickets
curl -s -X POST localhost:8080/api/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"eventId":1,"items":[{"ticketTypeId":1,"quantity":2}],"paymentMethod":"mpesa"}' | jq

# 4. Wait ~2 seconds for the simulated payment webhook, then check status —
#    it resolves from pending_payment to paid on its own.
curl -s localhost:8080/api/orders/1 -H "Authorization: Bearer $TOKEN" | jq

# 5. See your tickets with real QR PNGs (base64 data URLs)
curl -s localhost:8080/api/tickets/mine -H "Authorization: Bearer $TOKEN" | jq
```

Then, as check-in staff, scan one of the tokens from step 5 against
`POST /api/checkin/scan` — scan it twice and watch the second attempt
come back `409 duplicate`.

## Try seat-level booking

Seeded event id 2 ("Accra Jazz & Highlife Night") has real reserved seating
across four sections — this is what the prototype's interactive seat map now
renders from, instead of a purely client-side simulation.

```bash
# Browse the real seat map for the event
curl -s localhost:8080/api/events/2/seats | jq

# Book two specific seats (pass their real ids, not a bare quantity)
curl -s -X POST localhost:8080/api/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"eventId":2,"items":[{"ticketTypeId":3,"seatIds":[1,2]}],"paymentMethod":"card"}'

# Those exact seats are now "reserved" to everyone else immediately, and
# "sold" once the async payment settles — GET the seat list again to see it.
```

An organizer generates a new section on any event they own with:

```bash
curl -s -X POST localhost:8080/api/organizer/events/:id/seats \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ORG_TOKEN" \
  -d '{"ticketTypeId":3,"sectionName":"Orchestra","tier":"a","rows":6,"seatsPerRow":16}'
```

`rows*seatsPerRow` can't exceed that ticket type's `quantity_total` — the seat
rows are individually bookable subdivisions of the same inventory the plain
quantity counters already track, not a separate pool.

## Try the resale flow

```bash
# As the ticket owner, list one of your tickets (price is capped at face value)
curl -s -X POST localhost:8080/api/resale/list \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"ticketId":1,"price":30}'

# Anyone can browse the marketplace for an event
curl -s "localhost:8080/api/resale/listings?eventId=1" | jq

# A different logged-in user buys it — same async payment pattern as checkout
curl -s -X POST localhost:8080/api/resale/1/buy \
  -H "Content-Type: application/json" -H "Authorization: Bearer $OTHER_TOKEN" -d '{}'

# ~2 seconds later: the seller's original ticket is `invalidated` and the
# buyer's GET /api/tickets/mine shows a brand-new, validly signed ticket.
```

## Scope note on fraud detection

`checkOrderVelocity` flags — never silently blocks — an account placing
several orders for the same event in a short window, and every open signal
lands in `GET /api/admin/fraud-signals` for a human to clear or act on.
This is intentionally the simplest real signal worth having, not a full
fraud-scoring engine: device fingerprinting, IP reputation, card BIN
checks, and ML-based scoring are further work beyond this pass.

## API reference

**Auth**
- `POST /api/auth/register` — `{ name, email, password, role? }` → `{ token, user }`
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`
- `GET /api/auth/me` — current user

**Events (public)**
- `GET /api/events` — published events
- `GET /api/events/:id` — event + ticket types with live availability

**Organizer** (`organizer_owner` role)
- `POST /api/organizer/onboard` — `{ name, country, settlementMethod, settlementAccount }`
- `GET /api/organizer/me`
- `POST /api/organizer/events` — `{ name, category, startsAt, ticketTypes: [{name, price, quantity}], ... }` → creates a `pending_review` draft
- `GET /api/organizer/events/mine`
- `GET /api/organizer/events/:id/analytics` — real aggregates: gross sales, tickets sold, check-ins, per-ticket-type breakdown

**Orders / payments**
- `POST /api/orders` — `{ eventId, items: [{ticketTypeId, quantity}], paymentMethod, simulateOutcome? }` — reserves inventory, opens a payment intent, kicks off the (simulated) async settlement
- `GET /api/orders/:id` — status, items, and issued tickets (with QR data URLs) once paid
- `POST /api/orders/webhook/payments` — the payment provider's callback endpoint (HMAC-signed, idempotent)

**Tickets**
- `GET /api/tickets/mine`
- `POST /api/tickets/:id/transfer` — `{ toEmail }` — real ownership change to another existing account

**Check-in** (`organizer_owner` / `checkin_staff` / `platform_admin`)
- `POST /api/checkin/scan` — `{ token }` — online single scan, rejects duplicates and forged tokens
- `GET /api/checkin/manifest/:eventId` — signed offline manifest for the scanner app to cache
- `POST /api/checkin/sync` — `{ scans: [{jti, scannedAt}] }` — batch-replay queued offline scans

**Verified resale** (Phase 3)
- `POST /api/resale/list` — `{ ticketId, price }` — price is hard-capped at the ticket's face value; the ticket moves to `listed` (blocked from check-in/transfer while listed)
- `GET /api/resale/listings?eventId=` — public marketplace browse (seller identity not exposed)
- `GET /api/resale/mine` — your own listings
- `POST /api/resale/:id/cancel` — seller pulls a listing back to `valid`
- `POST /api/resale/:id/buy` — same async webhook-settled payment pattern as primary checkout; on success, the seller's original ticket is invalidated and a freshly signed ticket is issued to the buyer
- `GET /api/resale/orders/:id`
- `POST /api/resale/webhook/payments` — resale settlement callback (HMAC-signed, idempotent)

**Admin** (`platform_admin`)
- `GET /api/admin/organizers/pending`, `POST /:id/approve`, `POST /:id/reject`
- `GET /api/admin/events/pending`, `POST /:id/approve` (blocked until the organizer is verified), `POST /:id/reject`
- `POST /api/admin/tickets/:id/invalidate` — freeze a ticket (fraud/dispute)
- `GET /api/admin/audit-log` — recent platform actions
- `GET /api/admin/fraud-signals` — open signals (currently: order velocity per user/event), `POST /:id/clear`, `POST /:id/action`

## What would change for real production use

- Postgres is already in place — next steps are connection pooling tuning (`pg.Pool` max size vs. Cloud SQL's connection limit) and read replicas if traffic grows.
- Replace `mockPaymentProvider.js` with real M-Pesa/Flutterwave/Paystack/Stripe SDKs — the webhook route and idempotency logic don't need to change, only where the signature secret and callback payload come from.
- Replace `notify.js`'s console logging with real Africa's Talking/Twilio/WhatsApp Business API/SendGrid calls at the same trigger points.
- Move `TICKET_SECRET`, `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, and `MANIFEST_SECRET` into a real secrets manager, and rotate them independently.
- Add rate limiting, request validation (e.g. zod), and structured logging before internet-facing deployment.
