// src/utils/fraud.js
const db = require('../db');

// Simple velocity check: too many orders for the same event, from the same
// account, in a short window, is a classic bot/scalper signature. This does
// NOT block the order — it only raises a signal for a human to review in the
// admin Fraud Alerts queue.
async function checkOrderVelocity(userId, eventId, windowMinutes = 5, threshold = 3) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const rows = await db.query(
    `SELECT COUNT(*) AS n FROM orders WHERE user_id = $1 AND event_id = $2 AND created_at >= $3`,
    [userId, eventId, since]
  );
  const n = Number(rows[0].n);
  if (n >= threshold) {
    await db.query(
      `INSERT INTO fraud_signals (signal_type, severity, user_id, event_id, meta) VALUES ($1, $2, $3, $4, $5)`,
      ['velocity', n >= threshold * 2 ? 'high' : 'medium', userId, eventId, JSON.stringify({ ordersInWindow: n + 1, windowMinutes })]
    );
  }
}

module.exports = { checkOrderVelocity };
