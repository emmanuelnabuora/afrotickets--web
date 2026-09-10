// src/utils/notify.js
// Same stubbed-delivery approach as the SQLite build: records every
// notification as an in-app row and logs what would have gone out over
// each other channel. See the README for what plugs in here for production.
const db = require('../db');

async function notify(userId, type, payload, channels = ['in_app', 'email']) {
  for (const channel of channels) {
    await db.query(
      `INSERT INTO notifications (user_id, type, channel, payload) VALUES ($1, $2, $3, $4)`,
      [userId, type, channel, JSON.stringify(payload)]
    );
    if (channel !== 'in_app') {
      console.log(`[notify:${channel}] -> user ${userId} :: ${type}`, payload);
    }
  }
}

module.exports = { notify };
