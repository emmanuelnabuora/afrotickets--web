// seed.js
// Populates a demo admin, organizer, customer, and two published events
// (one general-admission, one reserved-seating) — Postgres version.
const db = require('./src/db');
const { hashPassword } = require('./src/auth');

async function upsertUser(name, email, password, role) {
  const existing = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (existing) return existing;
  return db.one(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, email, hashPassword(password), role]
  );
}

async function main() {
  await db.migrate();

  const admin = await upsertUser('David (Trust & Safety)', 'admin@afrotickets.com', 'admin12345', 'platform_admin');
  const organizerUser = await upsertUser('Zanele Dlamini', 'zanele@solgenerationlive.com', 'organizer12345', 'organizer_owner');
  const customer = await upsertUser('Amara Okafor', 'amara@example.com', 'customer12345', 'customer');
  const staff = await upsertUser('Check-in Staff', 'staff@solgenerationlive.com', 'staff12345', 'checkin_staff');

  let organizer = await db.one('SELECT * FROM organizers WHERE owner_user_id = $1', [organizerUser.id]);
  if (!organizer) {
    organizer = await db.one(
      `INSERT INTO organizers (owner_user_id, name, country, verification_status, settlement_method, settlement_account)
       VALUES ($1, $2, $3, 'approved', 'M-Pesa', '07XX-DEMO') RETURNING *`,
      [organizerUser.id, 'Sol Generation Live', 'Kenya']
    );
  }

  let event = await db.one('SELECT * FROM events WHERE organizer_id = $1', [organizer.id]);
  if (!event) {
    event = await db.one(
      `INSERT INTO events (organizer_id, name, category, description, venue, city, country, starts_at, currency, status)
       VALUES ($1, $2, 'Music', $3, 'Uhuru Gardens', 'Nairobi', 'Kenya', $4, 'KES', 'published') RETURNING *`,
      [organizer.id, 'Wizkid: More Love, Less Ego Tour', 'Wizkid brings his world tour to Nairobi for one night only.', '2026-11-21T19:00:00+03:00']
    );
    await db.query('INSERT INTO ticket_types (event_id, name, price_cents, quantity_total) VALUES ($1, $2, $3, $4)', [event.id, 'General Admission', 350000, 500]);
    await db.query('INSERT INTO ticket_types (event_id, name, price_cents, quantity_total) VALUES ($1, $2, $3, $4)', [event.id, 'VIP', 950000, 100]);
  }

  let seatedEvent = await db.one(`SELECT * FROM events WHERE name = 'Accra Jazz & Highlife Night'`);
  if (!seatedEvent) {
    const seatedOrg = await db.one(
      `INSERT INTO organizers (owner_user_id, name, country, verification_status, settlement_method, settlement_account)
       VALUES ($1, 'GhanaJazz Collective', 'Ghana', 'approved', 'Bank transfer', 'GH-DEMO-001') RETURNING *`,
      [organizerUser.id]
    );
    seatedEvent = await db.one(
      `INSERT INTO events (organizer_id, name, category, description, venue, city, country, starts_at, currency, status)
       VALUES ($1, 'Accra Jazz & Highlife Night', 'Music', $2, 'National Theatre', 'Accra', 'Ghana', $3, 'GHS', 'published') RETURNING *`,
      [seatedOrg.id, 'An evening of live highlife and Afro-jazz fusion at the National Theatre.', '2026-10-09T19:30:00']
    );

    const sections = [
      { name: 'Orchestra', tier: 'a', priceCents: 28000, rows: 6, seatsPerRow: 16 },
      { name: 'Balcony Center', tier: 'b', priceCents: 18000, rows: 4, seatsPerRow: 14 },
      { name: 'Balcony Left', tier: 'c', priceCents: 12000, rows: 4, seatsPerRow: 8 },
      { name: 'Balcony Right', tier: 'c', priceCents: 12000, rows: 4, seatsPerRow: 8 },
    ];
    const rowLetters = 'ABCDEFGH';
    for (const s of sections) {
      const seatCount = s.rows * s.seatsPerRow;
      const tt = await db.one(
        'INSERT INTO ticket_types (event_id, name, price_cents, quantity_total) VALUES ($1, $2, $3, $4) RETURNING id',
        [seatedEvent.id, s.name, s.priceCents, seatCount]
      );
      for (let r = 0; r < s.rows; r++) {
        for (let n = 1; n <= s.seatsPerRow; n++) {
          await db.query(
            'INSERT INTO event_seats (event_id, ticket_type_id, section_name, tier, row_label, seat_number) VALUES ($1, $2, $3, $4, $5, $6)',
            [seatedEvent.id, tt.id, s.name, s.tier, rowLetters[r], n]
          );
        }
      }
    }
  }

  console.log('Seed complete:\n');
  console.log('  Platform admin:  admin@afrotickets.com / admin12345');
  console.log('  Organizer owner: zanele@solgenerationlive.com / organizer12345');
  console.log('  Check-in staff:  staff@solgenerationlive.com / staff12345');
  console.log('  Customer:        amara@example.com / customer12345');
  console.log(`\n  General-admission event id: ${event.id} — "${event.name}"`);
  console.log(`  Reserved-seating event id: ${seatedEvent.id} — "${seatedEvent.name}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
